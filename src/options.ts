import { lastSegment } from './ast.js'

export interface AuditOptions {
  /**
   * Extra functions that check who is calling. A plain name matches the last part of the call
   * (`getMe` matches `getMe()` and `lib.getMe()`); a dotted name matches the end of the path
   * (`session.require` matches `ctx.session.require()`).
   */
  authFunctions?: string[]
  /** Extra higher-order functions that wrap an action with an auth check: `export const a = withTeam(async () => …)`. */
  authWrappers?: string[]
  /** Extra action clients with auth middleware (next-safe-action, zsa): `teamClient.action(…)`. */
  authClients?: string[]
  /** Actions that are public on purpose (login, newsletter…). Same effect as a `// @public-action` comment. */
  publicActions?: string[]
  /** Files to skip (CLI only), as globs relative to the project root: `["app/legacy/**"]`. */
  ignore?: string[]
}

/** Auth.js / NextAuth v5 and Clerk: a bare `auth()` call. Other libraries' `x.auth()` are not checks. */
const EXACT_PATHS = ['auth']

/** Matched against the last part of the call. */
const NAMES = [
  'currentUser', // Clerk
  'getServerSession', // NextAuth v4
  'getKindeServerSession', // Kinde
  'validateRequest', // Lucia
  'getIronSession', // iron-session
  'withAuth', // WorkOS AuthKit
  'verifyIdToken', // Firebase Admin
  'verifySessionCookie', // Firebase Admin
  'jwtVerify', // jose
  'verifyToken',
  'verifyJwt',
  'verifyAccessToken',
  'getSession',
  'verifySession',
  'getCurrentUser',
  'getAuthUser',
  'getAuthenticatedUser',
  'getSessionUser',
  'getUserOrThrow',
  'requireAuth',
  'requireUser',
  'requireSession',
  'requireAdmin',
  'requireRole',
  'requirePermission',
  'checkAuth',
  'ensureAuth',
  'ensureUser',
  'assertAuth',
  'assertUser',
  'isAuthenticated',
  'authenticate',
  'authorize',
]

/** Matched against the end of the call path. */
const SUFFIXES = [
  'auth.getUser', // Supabase
  'auth.getClaims', // Supabase
  'auth.getSession', // Supabase
  'auth.protect', // Clerk
  'api.getSession', // Better Auth
]

/** Wrapper or client names that suggest an auth check: withAuth, validatedActionWithUser, authActionClient… */
export const AUTH_NAME = /auth|protect|guard|session|user|admin|private|secure|logged/i

/**
 * Helpers worth following when looking for an auth check: getCurrentUser, requireOwner, getViewer,
 * verifySession… A helper with an unrelated name (sendEmail, getLocale) may read the session for
 * other reasons, such as the user's language, so it is not followed.
 */
export const HELPER_NAME = /auth|session|user|viewer|account|member|owner|admin|role|permission|access|identity|token|login|guard|protect|secure|private|require|ensure|assert|verify|check|current|^me$|^whoami$/i

/**
 * Guards that read the session to keep logged-in users OUT (sign-up, login, password reset):
 * `throwIfAuthenticated`, `redirectIfLoggedIn`, `requireGuest`. They call `getSession()` but
 * protect nothing, so they are never followed or trusted.
 */
export const GUEST_GUARD = /(?:throw|redirect|fail|reject|error)If(?:Authenticated|Authed|LoggedIn|SignedIn|Session)|requireGuest|guestOnly|onlyGuests?|(?:require|ensure|assert)(?:Not|No)(?:Authenticated|LoggedIn|SignedIn|Session|User)|unauthenticated|anonymous/i

export interface ResolvedOptions {
  exactPaths: Set<string>
  names: Set<string>
  suffixes: string[]
  authWrappers: Set<string>
  authClients: Set<string>
  publicActions: Set<string>
  ignore: string[]
}

export function resolveOptions(options: AuditOptions = {}): ResolvedOptions {
  const extra = options.authFunctions ?? []
  return {
    exactPaths: new Set(EXACT_PATHS),
    names: new Set([...NAMES, ...extra.filter((name) => !name.includes('.'))]),
    suffixes: [...SUFFIXES, ...extra.filter((name) => name.includes('.'))],
    authWrappers: new Set(options.authWrappers ?? []),
    authClients: new Set(options.authClients ?? []),
    publicActions: new Set(options.publicActions ?? []),
    ignore: options.ignore ?? [],
  }
}

export function isAuthCall(path: string, options: ResolvedOptions): boolean {
  if (options.exactPaths.has(path)) return true
  if (options.names.has(lastSegment(path))) return true
  return options.suffixes.some((suffix) => path === suffix || path.endsWith(`.${suffix}`))
}

/** `schema.parse(x)`, `v.safeParse(schema, x)`… but not `JSON.parse` or `Date.parse`. */
const VALIDATION_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'validate', 'validateSync', 'validateAsync', 'assert'])
const NOT_VALIDATION = new Set(['JSON', 'Date', 'Number', 'URL', 'path', 'Math', 'BigInt', 'console', 'assert'])

export function isValidationCall(path: string): boolean {
  const method = lastSegment(path)
  if (!VALIDATION_METHODS.has(method)) return false
  const owner = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
  return !NOT_VALIDATION.has(lastSegment(owner) || owner)
}
