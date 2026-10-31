# server-action-audit

**Find the Next.js Server Actions that anyone can call.**

[![CI](https://github.com/i6moons/server-action-audit/actions/workflows/ci.yml/badge.svg)](https://github.com/i6moons/server-action-audit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/server-action-audit?color=cb3837)](https://www.npmjs.com/package/server-action-audit)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Server%20Action%20Audit-2088FF?logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/server-action-audit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Every `"use server"` function is a public HTTP endpoint. Anyone can call it with a POST request, from outside your UI, with any arguments. The [Next.js docs](https://nextjs.org/docs/app/guides/data-security) put it plainly: an auth check on the page does not protect the Server Actions defined in it, so each action has to check the session itself.

That check is easy to forget, and nothing reminds you. `server-action-audit` lists every Server Action in your app and flags the ones without an authorization check. It runs in your terminal, in CI, and in your editor through ESLint.

```sh
npx server-action-audit
```

![server-action-audit lists every Server Action and flags the unprotected ones](docs/demo.svg)

No config needed. It reads your code; it never runs it. Tested on five large open-source Next.js apps: 456 Server Actions, about a second per app.

## What it understands

| | |
| --- | --- |
| **Actions** | Exports of `"use server"` files (functions, arrow functions, `export { a as b }`, default exports) and inline actions (`<form action={async () => { "use server" … }}>`) |
| **Auth libraries** | Auth.js / NextAuth v5 (`auth()`), NextAuth v4 (`getServerSession`), Clerk (`auth()`, `currentUser()`, `auth.protect()`), Supabase (`supabase.auth.getUser()`, `getClaims()`), Better Auth (`auth.api.getSession()`), Lucia (`validateRequest()`), Kinde, iron-session, Firebase Admin (`verifyIdToken`, `verifySessionCookie`), WorkOS AuthKit (`withAuth()`) |
| **Your own helpers** | `getCurrentUser()`, `requireUser()`, `verifySession()`… and any helper that calls one of the above. It follows them across files (relative imports and tsconfig `paths` like `@/lib/dal`), through re-exports and React `cache()`, up to 4 levels deep. Only checks on the main path count: a check inside an `if` branch or a callback does not |
| **Inline actions** | An action declared in a component that uses the component's session (`const session = await auth()` in the page, `if (!session) return` in the action) |
| **Action clients** | [next-safe-action](https://next-safe-action.dev) and [zsa](https://github.com/IdoPesok/zsa). It reads the client's middleware, so `actionClient.action(…)` is protected when `actionClient` checks the session, and so is a client derived from it (`actionClient.use(…)`). Guards that keep logged-in users out (`throwIfAuthenticated`) do not count |
| **Wrappers** | `withAuth(async () => …)`, `validatedActionWithUser(schema, …)`: wrappers whose name says auth, or that you list in the config |
| **Input validation** | Warns when an action takes arguments and nothing parses them (Zod, Valibot, Yup, or a next-safe-action / zsa schema) |

## Public actions

Some actions are public on purpose: login, sign-up, newsletter. Say so with a comment, right before the action or at the top of its body:

```ts
// Anyone can subscribe. @public-action
export async function subscribe(email: string) {
  const { email: valid } = SubscribeSchema.parse({ email })
  // …
}
```

They show up as `○ public` and never fail the audit. A real auth check always wins over the marker.

## Configuration

Teach it your own names in `server-action-audit.config.json`, or under `"serverActionAudit"` in package.json:

```json
{
  "authFunctions": ["getMe", "session.require"],
  "authWrappers": ["withTeam"],
  "authClients": ["teamActionClient"],
  "publicActions": ["subscribe"],
  "ignore": ["app/legacy/**"]
}
```

- **`authFunctions`**: a plain name matches the end of the call (`getMe` matches `getMe()` and `lib.getMe()`). A dotted name matches the end of the path (`session.require` matches `ctx.session.require()`).
- **`authWrappers`**: functions that wrap an action with an auth check.
- **`authClients`**: next-safe-action or zsa clients with auth middleware.
- **`publicActions`**: action names to treat as public.
- **`ignore`**: globs, relative to the project root.

When an action isn't recognized, the report tells you which name to add.

## ESLint

The same analysis, in your editor. ESLint 9 or 10, flat config:

```js
// eslint.config.mjs
import serverActionAudit from 'server-action-audit/eslint'

export default [
  // …your config
  serverActionAudit.configs.recommended,
]
```

| Rule | Default | |
| --- | --- | --- |
| `server-action-audit/require-auth` | error | Server Action without an authorization check |
| `server-action-audit/require-input-validation` | warn | Server Action that uses its arguments without validating them |

Options go in `settings.serverActionAudit` (shared by both rules) or on each rule. They use the same format as the config file, without `ignore`.

## CI

The CLI exits with code 1 when it finds an unprotected action, so any CI can run it:

```sh
npx server-action-audit
```

### GitHub Actions

Problems show up as annotations on the pull request, right on the line of the action:

```yaml
# .github/workflows/security.yml
name: Security
on: [pull_request]
jobs:
  server-actions:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: i6moons/server-action-audit@v0
        with:
          path: .            # where your Next.js app is
          fail-on: unprotected
```

To also get the report as a comment on the pull request, set `comment: true` and let the job write to pull requests. The action keeps a single comment and updates it on every push. It only comments once there is something to fix. If the job can't comment (pull requests from forks only get a read-only token), it shows a warning and the audit result stays the same.

```yaml
jobs:
  server-actions:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
      - uses: i6moons/server-action-audit@v0
        with:
          comment: true
```

For GitHub code scanning (the Security tab), upload the SARIF output:

```yaml
      - run: npx server-action-audit --format sarif > server-actions.sarif || true
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: server-actions.sarif
```

### Options

| Option | |
| --- | --- |
| `--fail-on unprotected` | Default. Fail on actions without an auth check |
| `--fail-on unvalidated` | Also fail on unvalidated input |
| `--fail-on never` | Report only |
| `--format pretty` | Default. Human-readable report |
| `--format json` | Machine-readable output (`--json` works too) |
| `--format github` | GitHub Actions annotations |
| `--format sarif` | SARIF 2.1.0, for code scanning |
| `--format markdown` | Markdown, e.g. `>> "$GITHUB_STEP_SUMMARY"` |
| `--pr-comment` | In GitHub Actions, also post the report on the pull request (needs `GITHUB_TOKEN` with `pull-requests: write`) |
| `--quiet` | Show problems only |
| `--config <file>` | Another config file |

## What it does not check

This is a static check that works on names. Treat a green report as "nothing obviously missing", not as proof that your app is secure.

- **It does not check what you do with the session.** `await auth()` counts as a check even if you then ignore the result. Make sure you stop when there is no user.
- **It does not check ownership.** Being logged in is not the same as being allowed to delete *this* post. Check that the resource belongs to the user.
- **Middleware is not counted.** The Next.js docs recommend checking inside each action, and middleware-only protection has been bypassed before ([CVE-2025-29927](https://nextjs.org/blog/cve-2025-29927)). If you rely on it anyway, mark those actions with `@public-action` or list your middleware helper in `authFunctions`.
- **Unusual patterns can slip through.** Dynamic imports, auth checks hidden in packages from `node_modules`, or a helper whose name contains `auth` without doing any check.

Found a false positive or a false negative? [Open an issue](https://github.com/i6moons/server-action-audit/issues) with the smallest snippet that reproduces it.

## API

```ts
import { scanProject, formatPretty } from 'server-action-audit'

const report = scanProject(process.cwd(), { authFunctions: ['getMe'] })
console.log(report.summary) // { actions, protected, unprotected, public, unvalidated }
```

## License

[MIT](LICENSE) © Del Prudence ([@i6moons](https://github.com/i6moons))

[Lire en français](README.fr.md)
