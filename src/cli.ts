import { resolve } from 'node:path'
import { formatGithub, formatJson, formatPretty, formatSarif } from './format.js'
import { loadConfig, scanProject } from './scan.js'
import { VERSION } from './version.js'

const HELP = `Usage: server-action-audit [dir] [options]

Lists every Next.js Server Action in [dir] (default: current directory) and
flags the ones without an authorization check.

Options
  --fail-on <level>   unprotected (default) | unvalidated | never
  --format <format>   pretty (default) | json | github | sarif
                      github: annotations on pull requests (GitHub Actions)
                      sarif: for GitHub code scanning
  --json              Same as --format json
  --quiet             Only show problems (pretty format)
  --config <file>     Options file (default: server-action-audit.config.json,
                      or "serverActionAudit" in package.json)
  -h, --help          Show this help
  -v, --version       Show the version

Exit codes: 0 ok, 1 problems found, 2 usage error.
`

function main(argv: string[]): number {
  let dir = '.'
  let format = 'pretty'
  let quiet = false
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
    else if (arg === '--fail-on' || arg.startsWith('--fail-on=')) failOn = arg.includes('=') ? arg.split('=')[1]! : (argv[++i] ?? '')
    else if (arg === '--config' || arg.startsWith('--config=')) configPath = arg.includes('=') ? arg.split('=')[1] : argv[++i]
    else if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n\n${HELP}`)
      return 2
    } else dir = arg
  }
  if (!['pretty', 'json', 'github', 'sarif'].includes(format)) {
    process.stderr.write(`--format must be pretty, json, github or sarif (got "${format}").\n`)
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
    format === 'json' ? formatJson(report) : format === 'github' ? formatGithub(report) : format === 'sarif' ? formatSarif(report, VERSION) : formatPretty(report, { quiet })
  process.stdout.write(`${output}\n`)

  const { unprotected, unvalidated } = report.summary
  if (failOn === 'unprotected' && unprotected) return 1
  if (failOn === 'unvalidated' && (unprotected || unvalidated)) return 1
  return 0
}

process.exitCode = main(process.argv.slice(2))
