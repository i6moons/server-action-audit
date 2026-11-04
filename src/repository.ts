import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectReport } from './scan.js'

const posix = (path: string) => path.split(sep).join('/')

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Where the scanned directory sits in its repository, with forward slashes: `''` at the root, `'apps/web'` in a
 * monorepo, `undefined` when it is in no repository.
 *
 * The nearest `.git` marks the root (a folder, or a file in worktrees and submodules). In GitHub Actions only
 * directories inside the workspace count, and the workspace is the root when the checkout has no `.git` (no git
 * on the runner).
 */
export function repositoryPath(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = resolve(root)
  const top = env.GITHUB_WORKSPACE ? resolve(env.GITHUB_WORKSPACE) : undefined
  if (top !== undefined && !inside(top, dir)) return undefined
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return posix(relative(current, dir))
    if (current === top || dirname(current) === current) break
  }
  return top === undefined ? undefined : posix(relative(top, dir))
}

/**
 * The report with its paths starting from the repository root instead of the scanned directory. GitHub needs
 * them that way to place annotations and code scanning results on the right file, and to link to it.
 */
export function fromRepositoryRoot(report: ProjectReport, path: string): ProjectReport {
  if (!path) return report
  const prefix = (file: string) => `${path}/${file}`
  return {
    ...report,
    files: report.files.map((file) => ({ ...file, file: prefix(file.file) })),
    errors: report.errors.map((error) => ({ ...error, file: prefix(error.file) })),
  }
}
