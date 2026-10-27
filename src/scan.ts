import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { analyzeModule, type ServerAction } from './analyze.js'
import { resolveOptions, type AuditOptions } from './options.js'
import { createNodeResolver, parseModule } from './resolve.js'

export interface FileReport {
  /** Relative to the project root, with forward slashes. */
  file: string
  actions: ServerAction[]
}

export interface ProjectReport {
  root: string
  files: FileReport[]
  /** Files that mention "use server" but could not be parsed. */
  errors: { file: string; message: string }[]
  summary: { actions: number; protected: number; unprotected: number; public: number; unvalidated: number }
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.output', '.svelte-kit', '.cache'])
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/

function globToRegExp(glob: string): RegExp {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*' && glob[i + 1] === '*') {
      pattern += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (char === '*') pattern += '[^/]*'
    else if (char === '?') pattern += '[^/]'
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`)
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) yield* sourceFiles(join(dir, entry.name))
    } else if (entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield join(dir, entry.name)
    }
  }
}

/** Options from `server-action-audit.config.json`, or the `serverActionAudit` key of package.json. */
export function loadConfig(root: string, configPath?: string): AuditOptions {
  if (configPath) return JSON.parse(readFileSync(configPath, 'utf8')) as AuditOptions
  const file = join(root, 'server-action-audit.config.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as AuditOptions
  const pkg = join(root, 'package.json')
  if (existsSync(pkg)) {
    const config = (JSON.parse(readFileSync(pkg, 'utf8')) as { serverActionAudit?: AuditOptions }).serverActionAudit
    if (config) return config
  }
  return {}
}

export function scanProject(root: string, options: AuditOptions = {}): ProjectReport {
  const resolved = resolveOptions(options)
  const ignore = resolved.ignore.map(globToRegExp)
  const resolver = createNodeResolver()
  const report: ProjectReport = { root, files: [], errors: [], summary: { actions: 0, protected: 0, unprotected: 0, public: 0, unvalidated: 0 } }

  for (const path of sourceFiles(root)) {
    const file = relative(root, path).split(sep).join('/')
    if (ignore.some((pattern) => pattern.test(file))) continue
    const text = readFileSync(path, 'utf8')
    if (!text.includes('use server')) continue
    let actions: ServerAction[]
    try {
      actions = analyzeModule({ ast: parseModule(text, path), text, filename: path }, resolved, resolver)
    } catch (error) {
      report.errors.push({ file, message: (error as Error).message })
      continue
    }
    if (!actions.length) continue
    report.files.push({ file, actions })
    for (const action of actions) {
      report.summary.actions++
      report.summary[action.status]++
      if (action.validated === false) report.summary.unvalidated++
    }
  }
  report.files.sort((a, b) => a.file.localeCompare(b.file))
  return report
}
