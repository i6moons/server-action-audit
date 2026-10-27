/** Minimal ESTree helpers, shared by the CLI (typescript-estree) and ESLint (espree or typescript-eslint). */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = { type: string; range?: [number, number]; loc?: { start: { line: number; column: number } }; [key: string]: any }

export interface Comment {
  type: string
  value: string
  range?: [number, number]
}

const SKIP = new Set(['parent', 'loc', 'range', 'tokens', 'comments', 'typeAnnotation', 'returnType', 'typeParameters'])

/** Calls `visit` on every node under `root`. Return `false` from `visit` to skip a node's children. */
export function walk(root: Node | null | undefined, visit: (node: Node) => boolean | void): void {
  if (!root || typeof root.type !== 'string') return
  if (visit(root) === false) return
  for (const key of Object.keys(root)) {
    if (SKIP.has(key)) continue
    const value = root[key]
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child, visit)
    } else if (value && typeof value.type === 'string') {
      walk(value, visit)
    }
  }
}

export function isFunction(node: Node | null | undefined): boolean {
  return !!node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression')
}

/** Leading string-literal statements of a program or function body. */
export function directives(body: Node[] | undefined): string[] {
  const found: string[] = []
  for (const statement of body ?? []) {
    if (statement.type !== 'ExpressionStatement') break
    if (typeof statement.directive === 'string') found.push(statement.directive)
    else if (statement.expression?.type === 'Literal' && typeof statement.expression.value === 'string') found.push(statement.expression.value)
    else break
  }
  return found
}

export function functionDirectives(fn: Node): string[] {
  return fn.body?.type === 'BlockStatement' ? directives(fn.body.body) : []
}

function unwrap(node: Node): Node {
  let current = node
  while (current.type === 'ChainExpression' || current.type === 'TSNonNullExpression' || current.type === 'TSAsExpression' || current.type === 'ParenthesizedExpression') {
    current = current.expression
  }
  return current
}

/**
 * Dotted path of a call's callee: `auth` → "auth", `supabase.auth.getUser` → "supabase.auth.getUser",
 * `(await createClient()).auth.getUser` → "*.auth.getUser". Computed members become "*".
 */
export function calleePath(callee: Node): string {
  const node = unwrap(callee)
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') {
    const property = !node.computed && node.property?.type === 'Identifier' ? node.property.name : '*'
    return `${calleePath(node.object)}.${property}`
  }
  if (node.type === 'Super') return 'super'
  if (node.type === 'ThisExpression') return 'this'
  return '*'
}

export function lastSegment(path: string): string {
  const index = path.lastIndexOf('.')
  return index === -1 ? path : path.slice(index + 1)
}

/** Every call expression inside `root`, nested functions included. */
export function callsIn(root: Node | null | undefined): Node[] {
  const calls: Node[] = []
  walk(root, (node) => {
    if (node.type === 'CallExpression') calls.push(node)
  })
  return calls
}

/**
 * Calls that run on the main path of `fn`: top-level statements, the condition of an `if`, the
 * body of a `try`. Calls in an `if` branch, a loop body or a nested callback may never run, so
 * they do not count as a guard. Inside an expression everything counts, so helper idioms like
 * `return token ? verify(token) : null` still do.
 *
 * With `followReturned`, a function returned at the top level is included too: that is the
 * function a wrapper like `withTeam(action)` actually runs on each request.
 */
export function unconditionalCalls(fn: Node, followReturned = false): Node[] {
  const calls: Node[] = []
  const expression = (node: Node | null | undefined): void => {
    if (!node || typeof node.type !== 'string' || isFunction(node)) return
    if (node.type === 'CallExpression') calls.push(node)
    for (const key of Object.keys(node)) {
      if (SKIP.has(key)) continue
      const value = node[key]
      if (Array.isArray(value)) value.forEach((child) => child && expression(child))
      else if (value && typeof value.type === 'string') expression(value)
    }
  }
  const returned = (node: Node | null | undefined): void => {
    if (followReturned && node && isFunction(node)) calls.push(...unconditionalCalls(node))
    else expression(node)
  }
  const statement = (node: Node | null | undefined): void => {
    if (!node) return
    switch (node.type) {
      case 'BlockStatement':
        for (const child of node.body ?? []) statement(child)
        break
      case 'ExpressionStatement':
        expression(node.expression)
        break
      case 'VariableDeclaration':
        for (const declarator of node.declarations ?? []) expression(declarator.init)
        break
      case 'ReturnStatement':
        returned(node.argument)
        break
      case 'ThrowStatement':
        expression(node.argument)
        break
      case 'IfStatement':
        expression(node.test)
        break
      case 'TryStatement':
        statement(node.block)
        break
      case 'SwitchStatement':
        expression(node.discriminant)
        break
      case 'DoWhileStatement':
        statement(node.body)
        break
      case 'LabeledStatement':
        statement(node.body)
        break
    }
  }
  if (fn.body?.type === 'BlockStatement') statement(fn.body)
  else returned(fn.body)
  return calls
}

/**
 * For `a.b(x).c(y).d(fn)`: the root identifier ("a"), the method names in call order (["b", "c", "d"])
 * and the function arguments passed anywhere in the chain.
 */
export function callChain(call: Node): { root: string | null; methods: string[]; functions: Node[]; identifiers: string[] } {
  const methods: string[] = []
  const functions: Node[] = []
  /** Identifiers passed as arguments: `.use(authMiddleware)`. */
  const identifiers: string[] = []
  let current: Node = unwrap(call)
  for (;;) {
    if (current.type === 'CallExpression') {
      for (const argument of current.arguments ?? []) {
        if (isFunction(argument)) functions.unshift(argument)
        else if (argument.type === 'Identifier') identifiers.unshift(argument.name)
      }
      const callee = unwrap(current.callee)
      if (callee.type === 'MemberExpression') {
        methods.unshift(!callee.computed && callee.property?.type === 'Identifier' ? callee.property.name : '*')
        current = unwrap(callee.object)
        continue
      }
      if (callee.type === 'Identifier') return { root: callee.name, methods, functions, identifiers }
      return { root: null, methods, functions, identifiers }
    }
    if (current.type === 'MemberExpression') {
      methods.unshift(!current.computed && current.property?.type === 'Identifier' ? current.property.name : '*')
      current = unwrap(current.object)
      continue
    }
    if (current.type === 'AwaitExpression') {
      current = unwrap(current.argument)
      continue
    }
    return { root: current.type === 'Identifier' ? current.name : null, methods, functions, identifiers }
  }
}

export function position(node: Node): { line: number; column: number } {
  return node.loc ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : { line: 0, column: 0 }
}
