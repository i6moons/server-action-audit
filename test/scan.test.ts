import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { formatGithub, formatJson, formatPretty, formatSarif, loadConfig, resolveImportPath, scanProject } from '../src/index.js'

const root = fileURLToPath(new URL('./fixtures/next-app', import.meta.url))

describe('scanProject', () => {
  const report = scanProject(root, loadConfig(root))
  const byName = Object.fromEntries(report.files.flatMap((f) => f.actions.map((a) => [a.name, { ...a, file: f.file }])))

  it('finds the actions of a Next.js app, skipping node_modules and ignored folders', () => {
    expect(report.files.map((f) => f.file)).toEqual(['app/(auth)/actions.ts', 'app/(dashboard)/posts/actions.ts', 'app/page.tsx'])
    expect(report.summary).toEqual({ actions: 6, protected: 3, unprotected: 2, public: 1, unvalidated: 4 })
  })

  it('follows the @/ alias from tsconfig.json to the auth helper', () => {
    expect(byName.createPost).toMatchObject({ status: 'protected', reason: 'getCurrentUserOrRedirect() → auth()', validated: true })
    expect(byName.updatePost).toMatchObject({ status: 'protected', validated: false })
  })

  it('flags the unprotected ones', () => {
    expect(byName.deletePost).toMatchObject({ status: 'unprotected', line: 16 })
    expect(byName['(inline action)']).toMatchObject({ status: 'unprotected', kind: 'inline', file: 'app/page.tsx' })
  })

  it('reads next-safe-action clients and public markers', () => {
    expect(byName.publishPost).toMatchObject({ status: 'protected', reason: 'authActionClient client', validated: true })
    expect(byName.login).toMatchObject({ status: 'public', validated: false })
  })

  it('prints a readable report and valid JSON', () => {
    const pretty = formatPretty(report)
    expect(pretty).toContain('6 Server Actions in 3 files')
    expect(pretty).toMatch(/✗ deletePost/)
    expect(pretty).toContain('2 unprotected')
    const json = JSON.parse(formatJson(report))
    expect(json.files[1].actions[1]).not.toHaveProperty('node')
    expect(json.summary.unprotected).toBe(2)
  })

  it('shows only problems with quiet', () => {
    expect(formatPretty(report, { quiet: true })).not.toContain('publishPost')
  })

  it('prints GitHub annotations with escaped properties', () => {
    const lines = formatGithub(report).split('\n')
    expect(lines).toContain(
      '::error file=app/(dashboard)/posts/actions.ts,line=16,col=1,title=server-action-audit/require-auth::Server Action "deletePost" has no authorization check: anyone can call it with a POST request. Check the session inside the action, or mark it with // @public-action if it is public on purpose.',
    )
    expect(lines.filter((line) => line.startsWith('::error'))).toHaveLength(2)
    expect(lines.filter((line) => line.startsWith('::warning'))).toHaveLength(4)
  })

  it('prints valid SARIF 2.1.0', () => {
    const sarif = JSON.parse(formatSarif(report, '9.9.9'))
    expect(sarif.version).toBe('2.1.0')
    const run = sarif.runs[0]
    expect(run.tool.driver).toMatchObject({ name: 'server-action-audit', version: '9.9.9' })
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(['require-auth', 'require-input-validation'])
    expect(run.results).toHaveLength(6)
    expect(run.results[0].locations[0].physicalLocation).toEqual({ artifactLocation: { uri: 'app/(auth)/actions.ts' }, region: { startLine: 6, startColumn: 1 } })
  })
})

describe('resolveImportPath', () => {
  it('resolves relative imports, tsconfig aliases and .js specifiers pointing at .ts files', () => {
    const from = `${root}/app/(dashboard)/posts/actions.ts`
    expect(resolveImportPath('@/lib/dal', from)).toBe(`${root}/lib/dal.ts`)
    expect(resolveImportPath('../../../lib/auth', from)).toBe(`${root}/lib/auth.ts`)
    expect(resolveImportPath('../../../lib/auth.js', from)).toBe(`${root}/lib/auth.ts`)
    expect(resolveImportPath('zod', from)).toBeNull()
  })
})
