import { callChain, calleePath, callsIn, directives, functionDirectives, isFunction, position, unconditionalCalls, walk, type Comment, type Node } from './ast.js'
import { AUTH_NAME, GUEST_GUARD, HELPER_NAME, isAuthCall, isValidationCall, type ResolvedOptions } from './options.js'

export type ActionStatus = 'protected' | 'unprotected' | 'public'

export interface ServerAction {
  /** Exported name, function name, or `(inline)` for an anonymous inline action. */
  name: string
  /** `module`: exported from a "use server" file. `inline`: a function with its own "use server" directive. */
  kind: 'module' | 'inline'
  line: number
  column: number
  status: ActionStatus
  /** Why it counts as protected or public: `auth()`, `getUser() → supabase.auth.getUser()`, `authActionClient client`… */
  reason: string | null
  /** `false` when the action takes arguments and nothing validates them; `null` when it takes none. */
  validated: boolean | null
  /** Advice when the tool could not see an auth check. */
  hint: string | null
  node: Node
}

export interface ModuleSource {
  ast: Node
  filename: string
}

/** Turns an import specifier into the parsed module, or `null` (package, missing file…). */
export type ImportResolver = (specifier: string, fromFile: string) => ModuleSource | null

export interface AnalyzeInput {
  ast: Node
  text: string
  filename: string
  comments?: Comment[]
}

const PUBLIC_MARKER = /@public-action\b/
const CLIENT_METHODS = new Set(['action', 'stateAction', 'handler', 'createServerAction', 'createAction'])
const SCHEMA_METHODS = new Set(['schema', 'inputSchema', 'input', 'bindArgsSchemas'])
const MAX_DEPTH = 4

type Reexport = { source: string; imported: string }

/** What a module declares at the top level: functions, imports and exports. */
class ModuleScope {
  readonly functions = new Map<string, Node>()
  readonly imports = new Map<string, Reexport>()
  readonly exports = new Map<string, string | Reexport>()
  /** Top-level declarations by name, with the statement that holds them (for comments). */
  readonly declarations = new Map<string, { init: Node; statement: Node }>()

  constructor(readonly ast: Node, readonly filename: string) {
    for (const statement of ast.body ?? []) this.index(statement)
  }

  private declare(name: string, init: Node, statement: Node): void {
    this.declarations.set(name, { init, statement })
    if (isFunction(init)) this.functions.set(name, init)
    // `export const getUser = cache(async () => …)`: the wrapped function is what runs.
    else if (init.type === 'CallExpression') {
      const wrapped = (init.arguments ?? []).find((argument: Node) => isFunction(argument))
      if (wrapped) this.functions.set(name, wrapped)
    }
  }

  private index(statement: Node): void {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
      for (const specifier of statement.specifiers ?? []) {
        const imported =
          specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : (specifier.imported?.name ?? specifier.imported?.value)
        this.imports.set(specifier.local.name, { source: statement.source.value, imported })
      }
      return
    }
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      this.declare(declaration.id.name, declaration, statement)
      if (statement.type === 'ExportNamedDeclaration') this.exports.set(declaration.id.name, declaration.id.name)
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations ?? []) {
        if (declarator.id?.type !== 'Identifier' || !declarator.init) continue
        this.declare(declarator.id.name, declarator.init, statement)
        if (statement.type === 'ExportNamedDeclaration') this.exports.set(declarator.id.name, declarator.id.name)
      }
    }
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
      for (const specifier of statement.specifiers ?? []) {
        const exported = specifier.exported?.name ?? specifier.exported?.value
        const local = specifier.local?.name ?? specifier.local?.value
        this.exports.set(exported, statement.source ? { source: statement.source.value, imported: local } : local)
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const value = statement.declaration
      if (value?.type === 'Identifier') this.exports.set('default', value.name)
      else if (value) {
        this.declare('default', value, statement)
        this.exports.set('default', 'default')
      }
    }
  }
}

interface Context {
  options: ResolvedOptions
  resolver: ImportResolver | undefined
  scopes: Map<string, ModuleScope>
}

function scopeOf(module: ModuleSource, context: Context): ModuleScope {
  let scope = context.scopes.get(module.filename)
  if (!scope) {
    scope = new ModuleScope(module.ast, module.filename)
    context.scopes.set(module.filename, scope)
  }
  return scope
}

/** The function a name refers to in `scope`: a local function, or an imported one (followed across files). */
function resolveFunction(name: string, scope: ModuleScope, context: Context, depth: number): { fn: Node; scope: ModuleScope } | null {
  const local = scope.functions.get(name)
  if (local) return { fn: local, scope }
  const binding = scope.imports.get(name)
  if (!binding || !context.resolver || depth > MAX_DEPTH) return null
  return exportedFunction(binding, scope, context, depth + 1)
}

function exportedFunction(binding: Reexport, from: ModuleScope, context: Context, depth: number): { fn: Node; scope: ModuleScope } | null {
  if (depth > MAX_DEPTH || binding.imported === '*') return null
  const module = context.resolver?.(binding.source, from.filename)
  if (!module) return null
  const scope = scopeOf(module, context)
  const entry = scope.exports.get(binding.imported)
  if (entry === undefined) return null
  if (typeof entry === 'string') {
    const fn = scope.functions.get(entry)
    return fn ? { fn, scope } : resolveFunction(entry, scope, context, depth)
  }
  return exportedFunction(entry, scope, context, depth + 1)
}

/**
 * First auth check that always runs when `fn` runs, directly or through helpers it calls:
 * "auth()", "getUser() → auth()". A check inside a branch or a callback does not count.
 */
function authEvidence(fn: Node, scope: ModuleScope, context: Context, depth = 0, seen = new Set<Node>(), followReturned = false): string | null {
  if (depth > MAX_DEPTH || seen.has(fn)) return null
  seen.add(fn)
  const calls = unconditionalCalls(fn, followReturned)
  for (const call of calls) {
    const path = calleePath(call.callee)
    if (isAuthCall(path, context.options)) return `${path}()`
  }
  for (const call of calls) {
    const path = calleePath(call.callee)
    if (path.includes('.') || path === '*' || GUEST_GUARD.test(path) || !HELPER_NAME.test(path)) continue
    const helper = resolveFunction(path, scope, context, depth)
    if (!helper) continue
    const evidence = authEvidence(helper.fn, helper.scope, context, depth + 1, seen)
    if (evidence) return `${path}() → ${evidence}`
  }
  return null
}

function boundNames(pattern: Node | null | undefined, names: string[] = []): string[] {
  if (!pattern) return names
  if (pattern.type === 'Identifier') names.push(pattern.name)
  else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties ?? []) boundNames(property.type === 'RestElement' ? property.argument : property.value, names)
  else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements ?? []) boundNames(element, names)
  else if (pattern.type === 'AssignmentPattern') boundNames(pattern.left, names)
  else if (pattern.type === 'RestElement') boundNames(pattern.argument, names)
  return names
}

/**
 * An inline action that uses a value the enclosing component got from an auth check:
 * `const session = await auth()` in the page, then `if (!session) return` in the action.
 * Next.js encrypts the variables an inline action closes over, so the action sees the
 * session of the render that created it.
 */
function closureEvidence(action: Node, enclosing: Node, scope: ModuleScope, context: Context): string | null {
  if (enclosing.body?.type !== 'BlockStatement') return null
  const fromAuth = new Map<string, string>()
  for (const statement of enclosing.body.body ?? []) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declarator of statement.declarations ?? []) {
      const evidence = authEvidence({ type: 'ArrowFunctionExpression', params: [], body: declarator.init } as Node, scope, context)
      if (evidence) for (const name of boundNames(declarator.id)) fromAuth.set(name, evidence)
    }
  }
  if (!fromAuth.size) return null
  let found: string | null = null
  walk(action.body, (node) => {
    if (found) return false
    if (node.type === 'Identifier' && fromAuth.has(node.name)) found = `${node.name} from ${fromAuth.get(node.name)} in the enclosing component`
  })
  return found
}

function declarationFrom(binding: Reexport, from: ModuleScope, context: Context, depth: number): { init: Node; scope: ModuleScope } | null {
  if (depth > MAX_DEPTH || binding.imported === '*' || !context.resolver) return null
  const module = context.resolver(binding.source, from.filename)
  if (!module) return null
  const scope = scopeOf(module, context)
  const entry = scope.exports.get(binding.imported)
  if (typeof entry === 'string') return resolveDeclaration(entry, scope, context, depth + 1)
  return entry ? declarationFrom(entry, scope, context, depth + 1) : null
}

/** What a top-level name is initialized with, following imports: `actionClient.use(…)`, `cache(…)`. */
function resolveDeclaration(name: string, scope: ModuleScope, context: Context, depth: number): { init: Node; scope: ModuleScope } | null {
  const local = scope.declarations.get(name)
  if (local) return { init: local.init, scope }
  const binding = scope.imports.get(name)
  return binding ? declarationFrom(binding, scope, context, depth) : null
}

/**
 * Auth check in the definition of a wrapper, a client or a middleware, following clients derived
 * from other clients: `apiKeyClient = actionClient.use(…)`, where `actionClient` checks the session.
 */
function definitionEvidence(name: string, scope: ModuleScope, context: Context, depth = 0): string | null {
  if (depth > MAX_DEPTH || GUEST_GUARD.test(name)) return null
  if (depth > 0 && (context.options.authClients.has(name) || context.options.authWrappers.has(name) || AUTH_NAME.test(name))) return name
  const definition = resolveFunction(name, scope, context, 0)
  const evidence = definition && authEvidence(definition.fn, definition.scope, context, 1, new Set(), true)
  if (evidence) return `${name} → ${evidence}`
  const declaration = resolveDeclaration(name, scope, context, 0)
  if (declaration?.init.type === 'CallExpression') {
    const chain = callChain(declaration.init)
    for (const base of [chain.root, ...chain.identifiers]) {
      if (!base || base === name) continue
      const inherited = definitionEvidence(base, declaration.scope, context, depth + 1)
      if (inherited) return `${name} → ${inherited}`
    }
  }
  return null
}

function validatesDirectly(fn: Node): boolean {
  return callsIn(fn.body).some((call) => isValidationCall(calleePath(call.callee)))
}

function parameterCount(fn: Node): number {
  return (fn.params ?? []).length
}

/** Comments right before `node` (only whitespace or other comments in between). */
function leadingComments(node: Node, comments: Comment[], text: string): Comment[] {
  const start = node.range?.[0]
  if (start === undefined) return []
  const found: Comment[] = []
  let cursor = start
  for (const comment of [...comments].reverse()) {
    const [from, to] = comment.range ?? [Infinity, Infinity]
    if (to > cursor) continue
    if (text.slice(to, cursor).trim() !== '') break
    found.push(comment)
    cursor = from
  }
  return found
}

/** Comments at the top of a function body, before its first real statement. */
function bodyHeadComments(fn: Node, comments: Comment[]): Comment[] {
  if (fn.body?.type !== 'BlockStatement' || !fn.body.range) return []
  const [bodyStart, bodyEnd] = fn.body.range as [number, number]
  const statements: Node[] = fn.body.body ?? []
  const firstReal = statements.find((statement) => !(statement.type === 'ExpressionStatement' && typeof statement.directive === 'string'))
  const limit = firstReal?.range?.[0] ?? bodyEnd
  return comments.filter((comment) => comment.range && comment.range[0] > bodyStart && comment.range[1] <= limit)
}

interface Candidate {
  name: string
  kind: 'module' | 'inline'
  /** The function itself, or the wrapper call (`withAuth(fn)`, `client.action(fn)`). */
  target: Node
  /** Nodes whose leading comments may mark the action public. */
  anchors: Node[]
  /** For an inline action: the component or function it is declared in. */
  enclosing?: Node | null
}

function moduleCandidates(scope: ModuleScope): Candidate[] {
  const candidates: Candidate[] = []
  for (const [exported, entry] of scope.exports) {
    if (typeof entry !== 'string') continue
    const declaration = scope.declarations.get(entry)
    if (!declaration) continue
    const { init, statement } = declaration
    const target = init.type === 'AwaitExpression' ? init.argument : init
    if (!isFunction(target) && target.type !== 'CallExpression') continue
    // `export default async function createPost()` reads better as "createPost" than "default".
    const name = exported === 'default' && target.id?.type === 'Identifier' ? target.id.name : exported
    candidates.push({ name, kind: 'module', target, anchors: [statement, init] })
  }
  return candidates
}

/** Functions with their own "use server" directive, named from where they appear. */
function inlineCandidates(ast: Node, skip: Set<Node>): Candidate[] {
  const candidates: Candidate[] = []
  const visit = (node: Node, parent: Node | null, grandparent: Node | null, enclosing: Node | null): void => {
    if (isFunction(node) && !skip.has(node) && functionDirectives(node).includes('use server')) {
      let name = node.id?.name as string | undefined
      if (!name && parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') name = parent.id.name
      if (!name && (parent?.type === 'Property' || parent?.type === 'MethodDefinition') && parent.key?.type === 'Identifier') name = parent.key.name
      if (!name && parent?.type === 'JSXExpressionContainer' && grandparent?.type === 'JSXAttribute') name = `(inline ${grandparent.name?.name ?? 'action'})`
      candidates.push({ name: name ?? '(inline)', kind: 'inline', target: node, anchors: [parent?.type === 'VariableDeclarator' ? grandparent ?? node : node], enclosing })
    }
    const inner = isFunction(node) ? node : enclosing
    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, node, parent, inner)
      } else if (value && typeof value.type === 'string') {
        visit(value, node, parent, inner)
      }
    }
  }
  visit(ast, null, null, null)
  return candidates
}

function analyzeCandidate(candidate: Candidate, scope: ModuleScope, context: Context, comments: Comment[], text: string): ServerAction {
  const { target } = candidate
  let reason: string | null = null
  let validated: boolean | null = null
  let hint: string | null = null
  const handlers: Node[] = []

  if (isFunction(target)) {
    handlers.push(target)
    reason = authEvidence(target, scope, context)
    if (!reason && candidate.enclosing) reason = closureEvidence(target, candidate.enclosing, scope, context)
    validated = parameterCount(target) === 0 ? null : validatesDirectly(target)
  } else {
    const chain = callChain(target)
    handlers.push(...chain.functions)
    const isClient = chain.methods.some((method) => CLIENT_METHODS.has(method))
    const root = chain.root
    const trusted = root !== null && (context.options.authClients.has(root) || context.options.authWrappers.has(root) || (AUTH_NAME.test(root) && !GUEST_GUARD.test(root)))
    if (trusted) reason = isClient ? `${root} client` : `${root}() wrapper`
    for (const handler of chain.functions) reason ??= authEvidence(handler, scope, context)
    // Read the definition of the wrapper, the client and its `.use(middleware)`:
    // `withTeam` → getUser() → verifyToken(), `myClient = base.use(async () => getSession())`.
    for (const name of [root, ...chain.identifiers]) {
      if (!reason && name) reason = definitionEvidence(name, scope, context)
    }
    if (isClient) {
      validated = chain.methods.some((method) => SCHEMA_METHODS.has(method)) ? true : null
    } else if (root && /valid|schema|zod|parse/i.test(root)) {
      validated = true
    } else {
      const handler = chain.functions[0]
      validated = !handler || parameterCount(handler) === 0 ? null : validatesDirectly(handler)
    }
    if (!reason && root) {
      hint = isClient
        ? `If "${root}" has auth middleware, add it to "authClients".`
        : `If ${root}() checks the session, add it to "authWrappers".`
    }
  }

  const markerComments = [
    ...candidate.anchors.flatMap((anchor) => leadingComments(anchor, comments, text)),
    ...handlers.flatMap((handler) => bodyHeadComments(handler, comments)),
  ]
  const markedPublic = markerComments.some((comment) => PUBLIC_MARKER.test(comment.value))
  const listedPublic = context.options.publicActions.has(candidate.name)
  const status: ActionStatus = reason ? 'protected' : markedPublic || listedPublic ? 'public' : 'unprotected'
  if (status === 'public') {
    reason = markedPublic ? '@public-action' : 'publicActions'
    hint = null
  }
  const { line, column } = position(candidate.anchors[0] ?? target)
  return { name: candidate.name, kind: candidate.kind, line, column, status, reason, validated, hint, node: candidate.anchors[0] ?? target }
}

/** Every Server Action declared in one module, with its protection status. */
export function analyzeModule(input: AnalyzeInput, options: ResolvedOptions, resolver?: ImportResolver): ServerAction[] {
  if (!input.text.includes('use server')) return []
  const context: Context = { options, resolver, scopes: new Map() }
  const scope = scopeOf({ ast: input.ast, filename: input.filename }, context)
  const comments = input.comments ?? (input.ast.comments as Comment[] | undefined) ?? []
  const candidates: Candidate[] = []
  if (directives(input.ast.body).includes('use server')) candidates.push(...moduleCandidates(scope))
  const covered = new Set(candidates.map((candidate) => candidate.target))
  candidates.push(...inlineCandidates(input.ast, covered))
  return candidates.map((candidate) => analyzeCandidate(candidate, scope, context, comments, input.text)).sort((a, b) => a.line - b.line || a.column - b.column)
}

