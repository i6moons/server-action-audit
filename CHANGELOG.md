# Changelog

## 0.1.0 (2026-10-27)

First release.

- `npx server-action-audit`: lists every Server Action of a Next.js app (exported from `"use server"` files, or inline) and flags the ones without an authorization check.
- Recognizes Auth.js / NextAuth, Clerk, Supabase, Better Auth, Lucia, Kinde, iron-session, Firebase Admin and WorkOS AuthKit, plus next-safe-action and zsa clients.
- Follows your own auth helpers across files, through tsconfig `paths` aliases, re-exports and React `cache()`.
- `// @public-action` marks actions that are public on purpose.
- Warns about actions that use their arguments without validating them.
- ESLint plugin (flat config): `require-auth` and `require-input-validation`.
- Reads the middleware of action clients, including clients derived from other clients, and the session an inline action closes over.
- Only counts checks on the main path of an action, follows only helpers whose name points to auth, and ignores guards that keep logged-in users out.
- `--format pretty | json | github | sarif` and `--fail-on` for CI; a GitHub Action that annotates pull requests.
