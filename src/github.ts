import { readFileSync } from 'node:fs'
import { VERSION } from './version.js'

/** Hidden at the top of the comment, so the next run edits it instead of adding another one. */
export const COMMENT_MARKER = '<!-- server-action-audit -->'

export interface PullRequest {
  apiUrl: string
  serverUrl: string
  /** owner/name */
  repository: string
  number: number
  headSha?: string
  token: string
}

interface IssueComment {
  id: number
  body?: string
}

/** The pull request a GitHub Actions run is for, from its environment, or why there is none. */
export function pullRequestFromEnv(env: NodeJS.ProcessEnv = process.env): PullRequest | string {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_EVENT_PATH) return 'not running in GitHub Actions'
  if (!env.GITHUB_TOKEN) return 'GITHUB_TOKEN is not set'
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { number: number; head?: { sha?: string } } }
  if (!event.pull_request) return `the "${env.GITHUB_EVENT_NAME ?? 'unknown'}" event is not about a pull request`
  return {
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
    repository: env.GITHUB_REPOSITORY,
    number: event.pull_request.number,
    headSha: event.pull_request.head?.sha,
    token: env.GITHUB_TOKEN,
  }
}

/**
 * Posts the report as a comment on the pull request, or updates the one an earlier run posted.
 * A clean report is only written over an earlier comment: a pull request with nothing to fix gets no comment.
 */
export async function upsertComment(
  pr: PullRequest,
  body: string,
  options: { clean: boolean; fetch?: typeof fetch },
): Promise<'created' | 'updated' | 'skipped'> {
  const request = async <T>(method: string, path: string, payload?: object): Promise<T> => {
    const response = await (options.fetch ?? fetch)(`${pr.apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${pr.token}`,
        'user-agent': `server-action-audit/${VERSION}`,
        'x-github-api-version': '2022-11-28',
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    })
    if (!response.ok) {
      const message = await response.json().then(
        (error) => (error as { message?: string }).message,
        () => undefined,
      )
      throw Object.assign(new Error(`${method} ${path} answered ${response.status}${message ? ` ${message}` : ''}`), { status: response.status })
    }
    return (await response.json()) as T
  }

  let previous: IssueComment | undefined
  for (let page = 1; !previous; page++) {
    const comments = await request<IssueComment[]>('GET', `/repos/${pr.repository}/issues/${pr.number}/comments?per_page=100&page=${page}`)
    previous = comments.find((comment) => comment.body?.startsWith(COMMENT_MARKER))
    if (comments.length < 100) break
  }

  const text = `${COMMENT_MARKER}\n${body}`
  if (previous) {
    if (previous.body === text) return 'skipped'
    await request('PATCH', `/repos/${pr.repository}/issues/comments/${previous.id}`, { body: text })
    return 'updated'
  }
  if (options.clean) return 'skipped'
  await request('POST', `/repos/${pr.repository}/issues/${pr.number}/comments`, { body: text })
  return 'created'
}
