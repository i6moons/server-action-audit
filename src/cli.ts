import { isAbsolute, relative, resolve, sep } from 'node:path'
import { formatGithub, formatJson, formatMarkdown, formatPretty, formatSarif } from './format.js'
import { pullRequestFromEnv, upsertComment } from './github.js'
import { loadConfig, scanProject, type ProjectReport } from './scan.js'
import { VERSION } from './version.js'

const HELP = `Usage: server-action-audit [dir] [options]

Lists every Next.js Server Action in [dir] (default: current directory) and
flags the ones without an authorization check.

Options
  --fail-on <level>   unprotected (default) | unvalidated | never
  --format <format>   pretty (default) | json | github | sarif | markdown
                      github: annotations on pull requests (GitHub Actions)
                      sarif: for GitHub code scanning
                      markdown: for a job summary
  --pr-comment        In GitHub Actions, also post the report as a comment
                      on the pull request, updated on every push. Uses
                      GITHUB_TOKEN, which needs pull-requests: write
  --json              Same as --format json
  --quiet             Only show problems (pretty format)
  --config <file>     Options file (default: server-action-audit.config.json,
                      or "serverActionAudit" in package.json)
  -h, --help          Show this help
  -v, --version       Show the version

Exit codes: 0 ok, 1 problems found, 2 usage error.
`

/** The link prefix for files of the scanned directory, when it is inside the checked-out repository. */
function sourceUrl(root: string, serverUrl: string, repository: string, sha: string | undefined): string | undefined {
  const path = relative(process.env.GITHUB_WORKSPACE || process.cwd(), root)
  if (!sha || path.startsWith('..') || isAbsolute(path)) return undefined
  return `${serverUrl}/${repository}/blob/${sha}/${path ? `${path.split(sep).join('/')}/` : ''}`
}

/** Never changes the exit code: a missing permission must not fail the audit. */
async function commentOnPullRequest(report: ProjectReport, root: string): Promise<void> {
  let pr
  try {
    pr = pullRequestFromEnv()
  } catch (error) {
    pr = `cannot read the event (${(error as Error).message})`
  }
  if (typeof pr === 'string') {
    process.stderr.write(`--pr-comment: no comment, ${pr}.\n`)
    return
  }
  const { unprotected, unvalidated } = report.summary
  try {
    const body = formatMarkdown(report, { sourceUrl: sourceUrl(root, pr.serverUrl, pr.repository, pr.headSha) })
    const result = await upsertComment(pr, body, { clean: !unprotected && !unvalidated })
    const done = { created: 'commented on', updated: 'updated its comment on', skipped: 'nothing new to post on' }[result]
    process.stderr.write(`--pr-comment: ${done} pull request #${pr.number}.\n`)
  } catch (error) {
    const { message, status } = error as Error & { status?: number }
    const hint = status === 403 || status === 404 ? ' The job needs "permissions: pull-requests: write" (pull requests from forks only get a read-only token).' : ''
    // A workflow command, so it shows up on the run. Written to stderr to keep stdout a clean report
    process.stderr.write(`::warning title=server-action-audit::Could not comment on pull request #${pr.number}: ${message}.${hint}\n`)
  }
}

async function main(argv: string[]): Promise<number> {
  let dir = '.'
  let format = 'pretty'
  let quiet = false
  let prComment = false
  let failOn = 'unprotected'
  let configPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP)
      return 0
    }
    if (arg === '-v' || arg === '--version') {
      process.stdout.write(`${VERSION}\n`)
      return 0
    }
    if (arg === '--json') format = 'json'
    else if (arg === '--format' || arg.startsWith('--format=')) format = arg.includes('=') ? arg.split('=')[1]! : (argv[++i] ?? '')
    else if (arg === '--quiet') quiet = true
    else if (arg === '--pr-comment') prComment = true
    else if (arg === '--fail-on' || arg.startsWith('--fail-on=')) failOn = arg.includes('=') ? arg.split('=')[1]! : (argv[++i] ?? '')
    else if (arg === '--config' || arg.startsWith('--config=')) configPath = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`)
      return 2
    } else dir = arg
  }
  if (!['pretty', 'json', 'github', 'sarif', 'markdown'].includes(format)) {
    process.stderr.write(`--format must be pretty, json, github, sarif or markdown (got "${format}").\n`)
    return 2
  }
  if (!['unprotected', 'unvalidated', 'never'].includes(failOn)) {
    process.stderr.write(`--fail-on must be unprotected, unvalidated or never (got "${failOn}").\n`)
    return 2
  }

  const root = resolve(dir)
  let report
  try {
    report = scanProject(root, loadConfig(root, configPath && resolve(configPath)))
  } catch (error) {
    process.stderr.write(`server-action-audit: ${(error as Error).message}\n`)
    return 2
  }
  const output =
    format === 'json'
      ? formatJson(report)
      : format === 'github'
        ? formatGithub(report)
        : format === 'sarif'
          ? formatSarif(report, VERSION)
          : format === 'markdown'
            ? formatMarkdown(report)
            : formatPretty(report, { quiet })
  process.stdout.write(`${output}\n`)
  if (prComment) await commentOnPullRequest(report, root)

  const { unprotected, unvalidated } = report.summary
  if (failOn === 'unprotected' && unprotected) return 1
  if (failOn === 'unvalidated' && (unprotected || unvalidated)) return 1
  return 0
}

process.exitCode = await main(process.argv.slice(2))
