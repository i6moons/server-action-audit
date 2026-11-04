# Changelog

## 0.2.1 (unreleased)

- Fix: in a monorepo (`path: apps/web` in the Action, or `npx server-action-audit apps/web`), annotations used paths from the app's folder (`app/actions.ts`) instead of the repository root (`apps/web/app/actions.ts`), so GitHub could not show them on the line in the pull request. The `github`, `sarif` and `markdown` formats and the pull request comment now use paths from the repository root. The `pretty` and `json` formats are unchanged.

## 0.2.0 (2026-10-31)

- `--pr-comment`: in GitHub Actions, posts the report as a comment on the pull request through the GitHub REST API, and updates that same comment on every push. A pull request with nothing to fix gets no comment. If the token can't write (forks, missing `pull-requests: write`), it shows a warning and keeps the exit code.
- GitHub Action: `comment` and `github-token` inputs for the above.
- `--format markdown`: a summary table with links to the code, for job summaries.

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
