import type { ESLint, Linter, Rule } from 'eslint'
import { analyzeModule, type ServerAction } from './analyze.js'
import type { Comment, Node } from './ast.js'
import { resolveOptions, type AuditOptions } from './options.js'
import { createNodeResolver } from './resolve.js'
import { VERSION } from './version.js'

const resolver = createNodeResolver()

const optionsSchema = {
  type: 'object',
  properties: {
    authFunctions: { type: 'array', items: { type: 'string' } },
    authWrappers: { type: 'array', items: { type: 'string' } },
    authClients: { type: 'array', items: { type: 'string' } },
    publicActions: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

/** Options from the rule, merged over `settings.serverActionAudit` (shared by both rules). */
function actionsOf(context: Rule.RuleContext): ServerAction[] {
  const text = context.sourceCode.text
  if (!text.includes('use server')) return []
  const shared = (context.settings?.serverActionAudit ?? {}) as AuditOptions
  const own = (context.options[0] ?? {}) as AuditOptions
  const options = resolveOptions({
    authFunctions: [...(shared.authFunctions ?? []), ...(own.authFunctions ?? [])],
    authWrappers: [...(shared.authWrappers ?? []), ...(own.authWrappers ?? [])],
    authClients: [...(shared.authClients ?? []), ...(own.authClients ?? [])],
    publicActions: [...(shared.publicActions ?? []), ...(own.publicActions ?? [])],
  })
  return analyzeModule(
    {
      ast: context.sourceCode.ast as unknown as Node,
      text,
      filename: context.physicalFilename ?? context.filename,
      comments: context.sourceCode.getAllComments() as unknown as Comment[],
    },
    options,
    resolver,
  )
}

const requireAuth: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require an authorization check in every Next.js Server Action',
      url: 'https://github.com/i6moons/server-action-audit#require-auth',
    },
    schema: [optionsSchema],
    messages: {
      missingAuth:
        'Server Action "{{name}}" has no authorization check: anyone can call it with a POST request. Check the session inside the action, or mark it with // @public-action if it is public on purpose.{{hint}}',
    },
  },
  create(context) {
    return {
      'Program:exit'() {
        for (const action of actionsOf(context)) {
          if (action.status !== 'unprotected') continue
          context.report({
            node: action.node as unknown as Rule.Node,
            messageId: 'missingAuth',
            data: { name: action.name, hint: action.hint ? ` ${action.hint}` : '' },
          })
        }
      },
    }
  },
}

const requireInputValidation: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require Server Actions to validate their arguments (Zod, Valibot, a next-safe-action schema…)',
      url: 'https://github.com/i6moons/server-action-audit#require-input-validation',
    },
    schema: [optionsSchema],
    messages: {
      missingValidation:
        'Server Action "{{name}}" uses its arguments without validating them. They come straight from the client: parse them with a schema (Zod, Valibot…).',
    },
  },
  create(context) {
    return {
      'Program:exit'() {
        for (const action of actionsOf(context)) {
          if (action.validated !== false) continue
          context.report({ node: action.node as unknown as Rule.Node, messageId: 'missingValidation', data: { name: action.name } })
        }
      },
    }
  },
}

const plugin = {
  meta: { name: 'server-action-audit', version: VERSION },
  rules: {
    'require-auth': requireAuth,
    'require-input-validation': requireInputValidation,
  },
  configs: {} as Record<string, Linter.Config>,
} satisfies ESLint.Plugin & { configs: Record<string, Linter.Config> }

plugin.configs.recommended = {
  name: 'server-action-audit/recommended',
  plugins: { 'server-action-audit': plugin },
  rules: {
    'server-action-audit/require-auth': 'error',
    'server-action-audit/require-input-validation': 'warn',
  },
}

export default plugin
