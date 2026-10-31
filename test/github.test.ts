import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMENT_MARKER, pullRequestFromEnv, upsertComment, type PullRequest } from '../src/index.js'

const pr: PullRequest = { apiUrl: 'https://api.github.test', serverUrl: 'https://github.test', repository: 'acme/shop', number: 7, token: 't0k3n' }

/** A fake GitHub API: `pages` are the existing comments, 100 per page like the real one. */
function fakeGitHub(pages: { id: number; body: string }[][], status = 200) {
  const calls: { method: string; url: string; body?: unknown; headers: Record<string, string> }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body && JSON.parse(init.body as string), headers: init.headers as Record<string, string> })
    if (status !== 200) return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status })
    const page = Number(new URL(url).searchParams.get('page') ?? 1)
    return Response.json(init.method === 'GET' ? (pages[page - 1] ?? []) : { id: 1 })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const filler = (count: number, from = 0) => Array.from({ length: count }, (_, i) => ({ id: from + i, body: 'LGTM' }))

describe('upsertComment', () => {
  it('posts a new comment with the marker and the API headers', async () => {
    const api = fakeGitHub([filler(3)])
    expect(await upsertComment(pr, 'report', { clean: false, fetch: api.fetch })).toBe('created')
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.github.test/repos/acme/shop/issues/7/comments?per_page=100&page=1',
      'POST https://api.github.test/repos/acme/shop/issues/7/comments',
    ])
    expect(api.calls[1]!.body).toEqual({ body: `${COMMENT_MARKER}\nreport` })
    expect(api.calls[1]!.headers).toMatchObject({ authorization: 'Bearer t0k3n', 'x-github-api-version': '2022-11-28' })
  })

  it('updates the comment of an earlier run, even on a later page', async () => {
    const api = fakeGitHub([filler(100), [...filler(2, 100), { id: 4242, body: `${COMMENT_MARKER}\nold report` }]])
    expect(await upsertComment(pr, 'new report', { clean: false, fetch: api.fetch })).toBe('updated')
    expect(api.calls.map((c) => `${c.method} ${c.url.replace('https://api.github.test', '')}`)).toEqual([
      'GET /repos/acme/shop/issues/7/comments?per_page=100&page=1',
      'GET /repos/acme/shop/issues/7/comments?per_page=100&page=2',
      'PATCH /repos/acme/shop/issues/comments/4242',
    ])
  })

  it('ignores comments that only quote the marker', async () => {
    const api = fakeGitHub([[{ id: 9, body: `> ${COMMENT_MARKER}\nwhy this comment?` }]])
    expect(await upsertComment(pr, 'report', { clean: false, fetch: api.fetch })).toBe('created')
  })

  it('posts nothing for a clean report, unless it replaces an earlier comment', async () => {
    const quiet = fakeGitHub([filler(1)])
    expect(await upsertComment(pr, 'all good', { clean: true, fetch: quiet.fetch })).toBe('skipped')
    expect(quiet.calls).toHaveLength(1)

    const fixed = fakeGitHub([[{ id: 5, body: `${COMMENT_MARKER}\n2 unprotected` }]])
    expect(await upsertComment(pr, 'all good', { clean: true, fetch: fixed.fetch })).toBe('updated')
  })

  it('leaves an unchanged comment alone', async () => {
    const api = fakeGitHub([[{ id: 5, body: `${COMMENT_MARKER}\nsame` }]])
    expect(await upsertComment(pr, 'same', { clean: false, fetch: api.fetch })).toBe('skipped')
    expect(api.calls).toHaveLength(1)
  })

  it('reports the status and the message of a refused request', async () => {
    const api = fakeGitHub([], 403)
    await expect(upsertComment(pr, 'report', { clean: false, fetch: api.fetch })).rejects.toThrow(
      'GET /repos/acme/shop/issues/7/comments?per_page=100&page=1 answered 403 Resource not accessible by integration',
    )
  })
})

describe('pullRequestFromEnv', () => {
  const event = (payload: object) => {
    const file = join(mkdtempSync(join(tmpdir(), 'saa-')), 'event.json')
    writeFileSync(file, JSON.stringify(payload))
    return file
  }

  it('reads the pull request from the GitHub Actions event', () => {
    const env = { GITHUB_REPOSITORY: 'acme/shop', GITHUB_TOKEN: 'abc', GITHUB_EVENT_PATH: event({ pull_request: { number: 12, head: { sha: 'f00' } } }) }
    expect(pullRequestFromEnv(env)).toEqual({ apiUrl: 'https://api.github.com', serverUrl: 'https://github.com', repository: 'acme/shop', number: 12, headSha: 'f00', token: 'abc' })
  })

  it('explains why there is no pull request', () => {
    expect(pullRequestFromEnv({})).toBe('not running in GitHub Actions')
    const push = event({ ref: 'refs/heads/main' })
    expect(pullRequestFromEnv({ GITHUB_REPOSITORY: 'acme/shop', GITHUB_EVENT_PATH: push })).toBe('GITHUB_TOKEN is not set')
    expect(pullRequestFromEnv({ GITHUB_REPOSITORY: 'acme/shop', GITHUB_EVENT_PATH: push, GITHUB_TOKEN: 'abc', GITHUB_EVENT_NAME: 'push' })).toBe(
      'the "push" event is not about a pull request',
    )
  })
})
