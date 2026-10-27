import type { ServerAction } from './analyze.js'
import type { ProjectReport } from './scan.js'

const useColor = process.env.FORCE_COLOR ? true : !process.env.NO_COLOR && !!process.stdout.isTTY
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
const red = paint('31')
const green = paint('32')
const yellow = paint('33')
const cyan = paint('36')
const dim = paint('2')
const bold = paint('1')

function describe(action: ServerAction): string {
  const parts: string[] = []
  if (action.status === 'protected') parts.push(dim(action.reason ?? ''))
  if (action.status === 'public') parts.push(cyan(`public (${action.reason})`))
  if (action.status === 'unprotected') parts.push(red('no auth check'))
  if (action.validated === false) parts.push(yellow('input not validated'))
  return parts.join(dim(' · '))
}

function symbol(action: ServerAction): string {
  if (action.status === 'unprotected') return red('✗')
  if (action.validated === false) return yellow('!')
  if (action.status === 'public') return cyan('○')
  return green('✓')
}

export function formatPretty(report: ProjectReport, options: { quiet?: boolean } = {}): string {
  const { summary } = report
  const lines: string[] = []
  const fileCount = report.files.length
  lines.push(bold(`server-action-audit · ${summary.actions} Server Action${summary.actions === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`), '')

  for (const { file, actions } of report.files) {
    const shown = options.quiet ? actions.filter((a) => a.status === 'unprotected' || a.validated === false) : actions
    if (!shown.length) continue
    lines.push(bold(file))
    const width = Math.min(32, Math.max(...shown.map((a) => a.name.length)))
    for (const action of shown) {
      const where = dim(`${action.line}:${action.column}`.padEnd(7))
      lines.push(`  ${symbol(action)} ${action.name.padEnd(width)}  ${where} ${describe(action)}`)
      if (action.status === 'unprotected' && action.hint) lines.push(`      ${dim(action.hint)}`)
    }
    lines.push('')
  }

  for (const error of report.errors) lines.push(yellow(`skipped ${error.file}: ${error.message}`))
  if (report.errors.length) lines.push('')

  if (!summary.actions) {
    lines.push('No Server Actions found.')
    return lines.join('\n')
  }
  lines.push(
    [
      summary.unprotected ? red(`✗ ${summary.unprotected} unprotected`) : green('✗ 0 unprotected'),
      green(`✓ ${summary.protected} protected`),
      cyan(`○ ${summary.public} public`),
      summary.unvalidated ? yellow(`! ${summary.unvalidated} with unvalidated input`) : dim('! 0 with unvalidated input'),
    ].join(dim('  ·  ')),
  )
  if (summary.unprotected) {
    lines.push(
      '',
      dim('Every Server Action is a public endpoint: anyone can call it with a POST request.'),
      dim('Check the session inside each action, or mark intentional ones with // @public-action.'),
      dim('https://nextjs.org/docs/app/guides/data-security'),
    )
  }
  return lines.join('\n')
}

export function formatJson(report: ProjectReport): string {
  return JSON.stringify(
    {
      summary: report.summary,
      files: report.files.map(({ file, actions }) => ({
        file,
        actions: actions.map(({ node: _node, ...action }) => action),
      })),
      errors: report.errors,
    },
    null,
    2,
  )
}

const AUTH_MESSAGE = (name: string) =>
  `Server Action "${name}" has no authorization check: anyone can call it with a POST request. Check the session inside the action, or mark it with // @public-action if it is public on purpose.`
const VALIDATION_MESSAGE = (name: string) =>
  `Server Action "${name}" uses its arguments without validating them. They come straight from the client: parse them with a schema (Zod, Valibot…).`

interface Finding {
  rule: 'require-auth' | 'require-input-validation'
  level: 'error' | 'warning'
  file: string
  action: ServerAction
  message: string
}

function findings(report: ProjectReport): Finding[] {
  const found: Finding[] = []
  for (const { file, actions } of report.files) {
    for (const action of actions) {
      if (action.status === 'unprotected') {
        found.push({ rule: 'require-auth', level: 'error', file, action, message: AUTH_MESSAGE(action.name) + (action.hint ? ` ${action.hint}` : '') })
      }
      if (action.validated === false) {
        found.push({ rule: 'require-input-validation', level: 'warning', file, action, message: VALIDATION_MESSAGE(action.name) })
      }
    }
  }
  return found
}

/** GitHub Actions workflow commands: the findings show up as annotations on the pull request. */
export function formatGithub(report: ProjectReport): string {
  const data = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const property = (text: string) => data(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
  const lines = findings(report).map(
    ({ rule, level, file, action, message }) =>
      `::${level} file=${property(file)},line=${action.line},col=${action.column},title=${property(`server-action-audit/${rule}`)}::${data(message)}`,
  )
  const { summary } = report
  lines.push(`server-action-audit: ${summary.actions} Server Actions, ${summary.unprotected} unprotected, ${summary.protected} protected, ${summary.public} public, ${summary.unvalidated} with unvalidated input.`)
  return lines.join('\n')
}

/** SARIF 2.1.0, for GitHub code scanning and other security dashboards. */
export function formatSarif(report: ProjectReport, version: string): string {
  const rules = [
    {
      id: 'require-auth',
      name: 'RequireAuth',
      shortDescription: { text: 'Server Action without an authorization check' },
      fullDescription: { text: 'Every Next.js Server Action is a public endpoint. This one does not check who is calling it.' },
      helpUri: 'https://github.com/i6moons/server-action-audit#readme',
      defaultConfiguration: { level: 'error' },
      properties: { tags: ['security', 'nextjs'], 'security-severity': '7.5', precision: 'medium' },
    },
    {
      id: 'require-input-validation',
      name: 'RequireInputValidation',
      shortDescription: { text: 'Server Action without input validation' },
      fullDescription: { text: 'The action uses arguments sent by the client without parsing them with a schema.' },
      helpUri: 'https://github.com/i6moons/server-action-audit#readme',
      defaultConfiguration: { level: 'warning' },
      properties: { tags: ['security', 'nextjs'], 'security-severity': '4.0', precision: 'medium' },
    },
  ]
  const results = findings(report).map(({ rule, level, file, action, message }) => ({
    ruleId: rule,
    ruleIndex: rule === 'require-auth' ? 0 : 1,
    level,
    message: { text: message },
    locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: action.line, startColumn: action.column } } }],
    partialFingerprints: { actionName: `${file}#${action.name}` },
  }))
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'server-action-audit', version, informationUri: 'https://github.com/i6moons/server-action-audit', rules } }, results }],
    },
    null,
    2,
  )
}
