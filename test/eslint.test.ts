import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { afterAll, describe, it } from 'vitest'
import plugin from '../src/eslint.js'

;(RuleTester as unknown as { afterAll: typeof afterAll }).afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
})

tester.run('require-auth', plugin.rules['require-auth'], {
  valid: [
    `'use server'\nexport async function a() { await auth() }`,
    `'use server'\n// @public-action\nexport async function subscribe(email: string) {}`,
    `export async function notAnAction() {}`,
    { code: `'use server'\nexport async function a() { await getMe() }`, options: [{ authFunctions: ['getMe'] }] },
    { code: `'use server'\nexport async function a() { await getMe() }`, settings: { serverActionAudit: { authFunctions: ['getMe'] } } },
  ],
  invalid: [
    {
      code: `'use server'\nexport async function deletePost(id: string) { await db.post.delete({ where: { id } }) }`,
      errors: [{ messageId: 'missingAuth', data: { name: 'deletePost', hint: '' }, line: 2 }],
    },
    {
      code: `export default function Page() {\n  return <form action={async () => { 'use server'; await db.reset() }} />\n}`,
      errors: [{ messageId: 'missingAuth', line: 2 }],
    },
    {
      code: `'use server'\nexport const a = actionClient.action(async () => {})`,
      errors: [{ messageId: 'missingAuth', data: { name: 'a', hint: ' If "actionClient" has auth middleware, add it to "authClients".' } }],
    },
  ],
})

tester.run('require-input-validation', plugin.rules['require-input-validation'], {
  valid: [
    `'use server'\nexport async function a(data: unknown) { await auth(); schema.parse(data) }`,
    `'use server'\nexport async function a() { await auth() }`,
    `'use server'\nexport const a = authClient.inputSchema(s).action(async ({ parsedInput }) => {})`,
  ],
  invalid: [
    {
      code: `'use server'\nexport async function a(data: FormData) { await auth(); await db.insert(data) }`,
      errors: [{ messageId: 'missingValidation', data: { name: 'a' } }],
    },
  ],
})

describe('recommended config', () => {
  it('enables both rules', () => {
    const rules = plugin.configs.recommended?.rules ?? {}
    if (rules['server-action-audit/require-auth'] !== 'error') throw new Error('require-auth should be an error')
    if (rules['server-action-audit/require-input-validation'] !== 'warn') throw new Error('require-input-validation should warn')
  })
})
