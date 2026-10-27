import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse } from '@typescript-eslint/typescript-estree'
import type { Node } from './ast.js'
import type { ImportResolver, ModuleSource } from './analyze.js'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']

export function parseModule(text: string, filename: string): Node {
  return parse(text, {
    jsx: !/\.[cm]?ts$/.test(filename),
    loc: true,
    range: true,
    comment: true,
  }) as unknown as Node
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** In TypeScript ESM, `import './session.js'` points at session.ts. */
const TS_SOURCES: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }

function tryFile(base: string): string | null {
  if (isFile(base)) return base
  const jsExtension = base.match(/\.(js|jsx|mjs|cjs)$/)?.[0]
  if (jsExtension) {
    for (const extension of TS_SOURCES[jsExtension] ?? []) {
      const candidate = base.slice(0, -jsExtension.length) + extension
      if (isFile(candidate)) return candidate
    }
  }
  for (const extension of EXTENSIONS) if (isFile(base + extension)) return base + extension
  for (const extension of EXTENSIONS) if (isFile(join(base, `index${extension}`))) return join(base, `index${extension}`)
  return null
}

/** JSON with comments and trailing commas, as tsconfig.json allows. */
function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else {
      out += char
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

interface PathMapping {
  base: string
  paths: Record<string, string[]>
}

const mappings = new Map<string, PathMapping | null>()

/** `compilerOptions.paths` of the nearest tsconfig.json or jsconfig.json. */
function pathMapping(fromDir: string): PathMapping | null {
  if (mappings.has(fromDir)) return mappings.get(fromDir)!
  let mapping: PathMapping | null = null
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = join(fromDir, name)
    if (!existsSync(file)) continue
    try {
      const config = parseJsonc(readFileSync(file, 'utf8')) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
      const options = config.compilerOptions ?? {}
      if (options.paths) mapping = { base: resolve(fromDir, options.baseUrl ?? '.'), paths: options.paths }
    } catch {
      mapping = null
    }
    break
  }
  if (!mapping) {
    const parent = dirname(fromDir)
    mapping = parent !== fromDir && !existsSync(join(fromDir, 'package.json')) ? pathMapping(parent) : null
  }
  mappings.set(fromDir, mapping)
  return mapping
}

function resolveAlias(specifier: string, fromFile: string): string | null {
  const mapping = pathMapping(dirname(fromFile))
  if (!mapping) return null
  for (const [pattern, targets] of Object.entries(mapping.paths)) {
    const star = pattern.indexOf('*')
    let captured: string | null = null
    if (star === -1) captured = specifier === pattern ? '' : null
    else {
      const prefix = pattern.slice(0, star)
      const suffix = pattern.slice(star + 1)
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length)
      }
    }
    if (captured === null) continue
    for (const target of targets) {
      const file = tryFile(resolve(mapping.base, target.replace('*', captured)))
      if (file) return file
    }
  }
  return null
}

export function resolveImportPath(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.')) return tryFile(resolve(dirname(fromFile), specifier))
  if (specifier.startsWith('/')) return tryFile(specifier)
  return resolveAlias(specifier, fromFile)
}

/**
 * Resolves relative imports and tsconfig `paths` aliases (`@/lib/session`), then parses the file.
 * Packages from node_modules are not followed. Parsed files are cached until they change on disk.
 */
export function createNodeResolver(): ImportResolver {
  const cache = new Map<string, { mtime: number; module: ModuleSource | null }>()
  return (specifier, fromFile) => {
    const file = resolveImportPath(specifier, fromFile)
    if (!file) return null
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return null
    }
    const cached = cache.get(file)
    if (cached && cached.mtime === mtime) return cached.module
    let module: ModuleSource | null = null
    try {
      module = { ast: parseModule(readFileSync(file, 'utf8'), file), filename: file }
    } catch {
      module = null
    }
    cache.set(file, { mtime, module })
    return module
  }
}
