import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { formatGithub, formatMarkdown, formatSarif, loadConfig, scanProject } from '../src/index.js'
import { fromRepositoryRoot, repositoryPath } from '../src/repository.js'

const tmp = mkdtempSync(join(tmpdir(), 'saa-repo-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Creates the folders (and a `.git` folder or file) under a fresh directory, and returns its path. */
function tree(name: string, dirs: string[], gitFile?: string): string {
  const base = join(tmp, name)
  for (const dir of dirs) mkdirSync(join(base, dir), { recursive: true })
  if (gitFile) writeFileSync(join(base, gitFile), 'gitdir: /elsewhere/.git/worktrees/x\n')
  return base
}

describe('repositoryPath', () => {
  it('gives the path of an app inside a repository, from its root', () => {
    const repo = tree('monorepo', ['.git', 'apps/web'])
    expect(repositoryPath(join(repo, 'apps/web'), undefined)).toBe('apps/web')
    expect(repositoryPath(repo, undefined)).toBe('')
  })

  it('accepts a .git file, as in worktrees and submodules', () => {
    const repo = tree('worktree', ['apps/web'], '.git')
    expect(repositoryPath(join(repo, 'apps/web'), undefined)).toBe('apps/web')
  })

  it('finds a repository checked out in a subfolder of the workspace', () => {
    const workspace = tree('checkout-path', ['repo/.git', 'repo/apps/web'])
    expect(repositoryPath(join(workspace, 'repo/apps/web'), workspace)).toBe('apps/web')
  })

  it('counts the workspace as the root of a checkout without .git, and never looks above it', () => {
    const outer = tree('no-git', ['.git', 'workspace/apps/web'])
    const workspace = join(outer, 'workspace')
    expect(repositoryPath(join(workspace, 'apps/web'), workspace)).toBe('apps/web')
  })

  it('gives nothing for a directory outside the workspace', () => {
    const outer = tree('outside', ['.git', 'workspace', 'other/app'])
    expect(repositoryPath(join(outer, 'other/app'), join(outer, 'workspace'))).toBeUndefined()
  })
})

describe('fromRepositoryRoot', () => {
  const root = fileURLToPath(new URL('./fixtures/next-app', import.meta.url))
  const report = scanProject(root, loadConfig(root))
  const inMonorepo = fromRepositoryRoot(report, 'apps/web')

  it('prefixes the paths of files and skipped files, and leaves the report alone at the root', () => {
    expect(inMonorepo.files.map((f) => f.file)).toEqual(['apps/web/app/(auth)/actions.ts', 'apps/web/app/(dashboard)/posts/actions.ts', 'apps/web/app/page.tsx'])
    expect(fromRepositoryRoot({ ...report, errors: [{ file: 'app/broken.ts', message: 'x' }] }, 'apps/web').errors).toEqual([{ file: 'apps/web/app/broken.ts', message: 'x' }])
    expect(fromRepositoryRoot(report, '')).toBe(report)
    expect(report.files[0]!.file).toBe('app/(auth)/actions.ts')
  })

  it('puts annotations, code scanning results and links on the file in the repository', () => {
    expect(formatGithub(inMonorepo).split('\n')).toContain(
      '::error file=apps/web/app/(dashboard)/posts/actions.ts,line=16,col=1,title=server-action-audit/require-auth::Server Action "deletePost" has no authorization check: anyone can call it with a POST request. Check the session inside the action, or mark it with // @public-action if it is public on purpose.',
    )
    const sarif = JSON.parse(formatSarif(inMonorepo, '9.9.9'))
    expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation).toEqual({ uri: 'apps/web/app/(auth)/actions.ts' })
    expect(formatMarkdown(inMonorepo, { sourceUrl: 'https://github.com/acme/shop/blob/f00/' })).toContain(
      '[apps/web/app/(dashboard)/posts/actions.ts:16](https://github.com/acme/shop/blob/f00/apps/web/app/%28dashboard%29/posts/actions.ts#L16)',
    )
  })
})
