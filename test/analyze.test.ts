import { describe, expect, it } from 'vitest'
import { analyzeModule, parseModule, resolveOptions, type AuditOptions, type ImportResolver } from '../src/index.js'

/** Analyzes `code` as app/actions.ts; `files` are other modules it can import, by specifier. */
function analyze(code: string, files: Record<string, string> = {}, options: AuditOptions = {}, filename = '/app/actions.ts') {
  const resolver: ImportResolver = (specifier) => {
    const text = files[specifier]
    return text === undefined ? null : { ast: parseModule(text, `/virtual/${specifier}.ts`), filename: `/virtual/${specifier}.ts` }
  }
  return analyzeModule({ ast: parseModule(code, filename), text: code, filename }, resolveOptions(options), resolver).map(({ node: _node, ...action }) => action)
}

const statusOf = (code: string, files?: Record<string, string>, options?: AuditOptions) =>
  Object.fromEntries(analyze(code, files, options).map((action) => [action.name, action.status]))

describe('finding Server Actions', () => {
  it('lists every export of a "use server" file', () => {
    const actions = analyze(`'use server'
      export async function a() {}
      export const b = async () => {}
      const c = async function () {}
      async function d() {}
      export { c, d as renamed }
      export default async function () {}
      export const notAnAction = 42
      async function helper() {}`)
    expect(actions.map((a) => a.name)).toEqual(['a', 'b', 'c', 'renamed', 'default'])
    expect(actions.every((a) => a.kind === 'module')).toBe(true)
  })

  it('finds inline actions in server components and names them', () => {
    const actions = analyze(`
      export default function Page() {
        async function save(formData: FormData) { 'use server' }
        const remove = async () => { 'use server' }
        return <form action={async () => { 'use server' }}><button formAction={save} /></form>
      }`, {}, {}, '/app/page.tsx')
    expect(actions.map((a) => [a.name, a.kind])).toEqual([
      ['save', 'inline'],
      ['remove', 'inline'],
      ['(inline action)', 'inline'],
    ])
  })

  it('ignores files without "use server" and "use server" in plain strings', () => {
    expect(analyze(`export async function a() {}`)).toEqual([])
    expect(analyze(`export function a() { return "use server" }`)).toEqual([])
  })

  it('reports line and column', () => {
    const [action] = analyze(`'use server'\n\nexport async function a() {}`)
    expect(action).toMatchObject({ line: 3, column: 1 })
  })
})

describe('auth checks', () => {
  it.each([
    ['Auth.js / NextAuth v5', `const session = await auth(); if (!session) throw new Error()`],
    ['NextAuth v4', `const session = await getServerSession(authOptions)`],
    ['Clerk', `const { userId } = await auth()`],
    ['Clerk currentUser', `const user = await currentUser()`],
    ['Clerk protect', `await auth.protect()`],
    ['Supabase', `const { data } = await supabase.auth.getUser()`],
    ['Supabase via client call', `const { data } = await (await createClient()).auth.getUser()`],
    ['Better Auth', `const session = await auth.api.getSession({ headers: await headers() })`],
    ['Lucia', `const { user } = await validateRequest()`],
    ['Kinde', `const { getUser } = getKindeServerSession()`],
    ['iron-session', `const session = await getIronSession(await cookies(), opts)`],
    ['Firebase Admin', `await getAuth().verifySessionCookie(cookie)`],
    ['custom require*', `const user = await requireUser()`],
  ])('recognizes %s', (_label, check) => {
    expect(statusOf(`'use server'\nexport async function a() { ${check}; await db.delete() }`)).toEqual({ a: 'protected' })
  })

  it('only counts checks on the main path, not in a branch or a callback', () => {
    expect(
      statusOf(`'use server'
        async function startCheckout() { const s = await auth(); return s }
        export async function signIn(data) {
          const user = await db.findUser(data.email)
          if (data.redirect === 'checkout') return startCheckout()
        }
        export async function guardInCondition() { if (!(await auth())) throw new Error() }
        export async function guardInTry() { try { await requireUser() } catch { redirect('/login') } }
        export async function guardInCallback(ids) { await Promise.all(ids.map(async () => auth())) }
        export async function guardInBranchOnly(data) { if (data.admin) { await requireAdmin() } await db.wipe() }`),
    ).toEqual({ signIn: 'unprotected', guardInCondition: 'protected', guardInTry: 'protected', guardInCallback: 'unprotected', guardInBranchOnly: 'unprotected' })
  })

  it('flags an action without any check', () => {
    const [action] = analyze(`'use server'\nexport async function deletePost(id: string) { await db.post.delete({ where: { id } }) }`)
    expect(action).toMatchObject({ name: 'deletePost', status: 'unprotected', reason: null })
  })

  it('does not take firebase.auth() or a DB getUser(id) for a check', () => {
    expect(statusOf(`'use server'\nexport async function a() { firebase.auth(); await db.getUser(1) }`)).toEqual({ a: 'unprotected' })
  })

  it('follows helpers declared in the same file', () => {
    const [action] = analyze(`'use server'
      async function requireOwner(id) { const s = await auth(); return s }
      export async function a(id) { await requireOwner(id) }`)
    expect(action).toMatchObject({ status: 'protected', reason: 'requireOwner() → auth()' })
  })

  it('follows helpers imported from other files, through cache() and re-exports', () => {
    const files = {
      '@/lib/dal': `import { cache } from 'react'
        import { createClient } from './supabase'
        export const getViewer = cache(async () => { const s = await createClient(); return s.auth.getUser() })`,
      '@/lib/index': `export { getViewer as me } from '@/lib/dal'`,
    }
    const [direct] = analyze(`'use server'\nimport { getViewer } from '@/lib/dal'\nexport async function a() { await getViewer() }`, files)
    expect(direct).toMatchObject({ status: 'protected', reason: 'getViewer() → s.auth.getUser()' })
    const [reexported] = analyze(`'use server'\nimport { me } from '@/lib/index'\nexport async function a() { await me() }`, files)
    expect(reexported?.status).toBe('protected')
  })

  it('does not follow type-only imports or unresolvable packages', () => {
    expect(statusOf(`'use server'\nimport { getStuff } from 'some-package'\nexport async function a() { await getStuff() }`)).toEqual({ a: 'unprotected' })
  })

  it('accepts extra auth functions from the options', () => {
    const code = `'use server'\nexport async function a() { await getMe(); await ctx.session.require() }`
    expect(statusOf(code)).toEqual({ a: 'unprotected' })
    expect(statusOf(code, {}, { authFunctions: ['getMe'] })).toEqual({ a: 'protected' })
    expect(statusOf(code, {}, { authFunctions: ['session.require'] })).toEqual({ a: 'protected' })
  })
})

describe('wrappers and action clients', () => {
  it('trusts wrappers whose name implies auth', () => {
    expect(
      statusOf(`'use server'
        export const a = withAuth(async (data) => {})
        export const b = validatedActionWithUser(schema, async (data, _, user) => {})
        export const c = validatedAction(schema, async (data) => {})
        export const d = withLogging(async () => {})`),
    ).toEqual({ a: 'protected', b: 'protected', c: 'unprotected', d: 'unprotected' })
  })

  it('looks inside the wrapped handler', () => {
    expect(statusOf(`'use server'\nexport const a = withLogging(async () => { await auth() })`)).toEqual({ a: 'protected' })
  })

  it('understands next-safe-action and zsa clients', () => {
    const actions = analyze(`'use server'
      export const a = authActionClient.inputSchema(schema).action(async ({ parsedInput, ctx }) => {})
      export const b = actionClient.inputSchema(schema).action(async ({ parsedInput }) => {})
      export const c = authedProcedure.createServerAction().input(schema).handler(async ({ input }) => {})
      export const d = teamClient.action(async () => {})`)
    expect(actions.map((a) => [a.name, a.status, a.validated])).toEqual([
      ['a', 'protected', true],
      ['b', 'unprotected', true],
      ['c', 'protected', true],
      ['d', 'unprotected', null],
    ])
    expect(actions[1]?.hint).toContain('authClients')
  })

  it('reads the definition of a wrapper, across files', () => {
    const files = {
      '@/lib/auth/middleware': `import { getUser } from '@/lib/db/queries'
        export function withTeam(action) { return async (formData) => { const user = await getUser(); if (!user) redirect('/'); return action(formData) } }
        export function withLogging(action) { return async (...args) => action(...args) }`,
      '@/lib/db/queries': `import { verifyToken } from '@/lib/auth/session'
        export async function getUser() { const c = (await cookies()).get('session'); return c && verifyToken(c.value) }`,
      '@/lib/auth/session': `export async function verifyToken(input) { return (await jwtVerify(input, key)).payload }`,
    }
    const actions = analyze(`'use server'
      import { withTeam, withLogging } from '@/lib/auth/middleware'
      export const checkout = withTeam(async (formData, team) => {})
      export const ping = withLogging(async () => {})`, files)
    expect(actions.map((a) => [a.name, a.status, a.reason])).toEqual([
      ['checkout', 'protected', 'withTeam → getUser() → verifyToken()'],
      ['ping', 'unprotected', null],
    ])
  })

  it('reads the middleware of an action client, whatever its name', () => {
    const files = {
      './safe-action': `export const base = createSafeActionClient({})
        export const teamClient = base.use(async ({ next }) => { const session = await getSession(); return next({ ctx: { session } }) })
        export const requireMember = async ({ next }) => { await requireAuth(); return next() }`,
    }
    const actions = analyze(`'use server'
      import { base, teamClient, requireMember } from './safe-action'
      export const a = teamClient.action(async () => {})
      export const b = base.use(requireMember).action(async () => {})
      export const c = base.action(async () => {})`, files)
    expect(actions.map((a) => [a.name, a.status])).toEqual([
      ['a', 'protected'],
      ['b', 'protected'],
      ['c', 'unprotected'],
    ])
  })

  it('never trusts guards that keep logged-in users out', () => {
    const files = {
      './auth/throw-if-authenticated': `export const throwIfAuthenticated = async ({ next }) => { const s = await getSession(); if (s) throw new Error('Already logged in'); return next() }`,
    }
    expect(
      statusOf(`'use server'
        import { throwIfAuthenticated } from './auth/throw-if-authenticated'
        export const signUp = actionClient.use(throwIfAuthenticated).action(async () => {})
        export const reset = unauthenticatedClient.action(async () => {})
        export async function register() { await redirectIfLoggedIn() }`, files),
    ).toEqual({ signUp: 'unprotected', reset: 'unprotected', register: 'unprotected' })
  })

  it('accepts extra clients and wrappers from the options', () => {
    const code = `'use server'\nexport const a = teamClient.action(async () => {})\nexport const b = inTeam(async () => {})`
    expect(statusOf(code, {}, { authClients: ['teamClient'], authWrappers: ['inTeam'] })).toEqual({ a: 'protected', b: 'protected' })
  })
})

describe('public actions', () => {
  it('honors // @public-action before the export or at the top of the body', () => {
    const actions = analyze(`'use server'
      // Anyone can subscribe. @public-action
      export async function subscribe(email: string) {}
      export async function login(formData: FormData) {
        // @public-action: the login form
        const data = schema.parse(Object.fromEntries(formData))
      }
      /** @public-action */
      export const signup = validatedAction(schema, async () => {})
      // not the marker
      export async function other() {}`)
    expect(actions.map((a) => [a.name, a.status, a.reason])).toEqual([
      ['subscribe', 'public', '@public-action'],
      ['login', 'public', '@public-action'],
      ['signup', 'public', '@public-action'],
      ['other', 'unprotected', null],
    ])
  })

  it('honors publicActions from the options', () => {
    expect(statusOf(`'use server'\nexport async function login() {}`, {}, { publicActions: ['login'] })).toEqual({ login: 'public' })
  })

  it('never lets the marker hide a real check', () => {
    expect(statusOf(`'use server'\n// @public-action\nexport async function a() { await auth() }`)).toEqual({ a: 'protected' })
  })
})

describe('input validation', () => {
  it.each([
    ['Zod parse', `schema.parse(data)`, true],
    ['Zod safeParse', `const r = Schema.safeParse(Object.fromEntries(data))`, true],
    ['Valibot', `v.parse(Schema, data)`, true],
    ['Yup', `await schema.validate(data)`, true],
    ['nothing', `await db.insert(data)`, false],
    ['JSON.parse is not validation', `JSON.parse(data)`, false],
  ])('%s', (_label, body, validated) => {
    const [action] = analyze(`'use server'\nexport async function a(data) { await auth(); ${body} }`)
    expect(action?.validated).toBe(validated)
  })

  it('is not required for actions without arguments', () => {
    const [action] = analyze(`'use server'\nexport async function a() { await auth() }`)
    expect(action?.validated).toBeNull()
  })
})

describe('helpers with unrelated names', () => {
  it('does not follow a helper that reads the session for something else', () => {
    const files = {
      './emails': `import { getTranslate } from './i18n'
        export async function sendInviteAcceptedEmail(to) { const t = await getTranslate(); await mailer.send(to, t('accepted')) }`,
      './i18n': `export async function getTranslate() { const locale = await getLocale(); return (key) => key }
        async function getLocale() { const session = await getSession(); return session?.user.locale ?? 'en' }`,
    }
    expect(
      statusOf(`'use server'
        import { sendInviteAcceptedEmail } from './emails'
        export async function acceptInvite(email) { await db.member.create({ email }); await sendInviteAcceptedEmail(email) }`, files),
    ).toEqual({ acceptInvite: 'unprotected' })
  })
})

describe('inline actions and the session of their component', () => {
  it('counts a session the action closes over', () => {
    const status = (code: string) => Object.fromEntries(analyze(code, {}, {}, '/app/invite/page.tsx').map((a) => [a.name, a.status]))
    expect(
      status(
        `export default async function InvitePage({ params }) {
          const session = await getServerSession(authOptions)
          const { user } = await validateRequest()
          const invite = await db.invite.find(params.id)
          const accept = async () => { 'use server'; if (!session) return; await db.member.create({ userId: session.user.id }) }
          const acceptToo = async () => { 'use server'; await db.member.create({ userId: user.id }) }
          const reject = async () => { 'use server'; await db.invite.delete(invite.id) }
          return <form action={accept} />
        }`,
      ),
    ).toEqual({ accept: 'protected', acceptToo: 'protected', reject: 'unprotected' })
  })
})

describe('derived action clients', () => {
  it('follows a client built from another client', () => {
    const files = {
      '@/utils/safe-action': `export const actionClient = createSafeActionClient({}).use(async ({ next }) => { const session = await auth(); if (!session) throw new Error(); return next({ ctx: { session } }) })
        export const publicClient = createSafeActionClient({})`,
    }
    const actions = analyze(`'use server'
      import { actionClient, publicClient } from '@/utils/safe-action'
      const apiKeyClient = actionClient.use(async ({ ctx, next }) => { if (ctx.session.otp) throw new Error(); return next() })
      const rateLimited = publicClient.use(async ({ next }) => next())
      export const createKey = apiKeyClient.action(async () => {})
      export const ping = rateLimited.action(async () => {})`, files)
    expect(actions.map((a) => [a.name, a.status, a.reason])).toEqual([
      ['createKey', 'protected', 'apiKeyClient → actionClient → auth()'],
      ['ping', 'unprotected', null],
    ])
  })
})
