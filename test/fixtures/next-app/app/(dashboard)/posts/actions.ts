'use server'

import { z } from 'zod'
import { getCurrentUserOrRedirect } from '@/lib/dal'
import { authActionClient } from '@/lib/safe-action'
import { db } from '@/lib/db'

const PostSchema = z.object({ title: z.string() })

export async function createPost(formData: FormData) {
  const user = await getCurrentUserOrRedirect()
  const data = PostSchema.parse(Object.fromEntries(formData))
  await db.post.create({ data: { ...data, authorId: user.id } })
}

export async function deletePost(id: string) {
  await db.post.delete({ where: { id } })
}

export async function updatePost(id: string, title: string) {
  await getCurrentUserOrRedirect()
  await db.post.update({ where: { id }, data: { title } })
}

export const publishPost = authActionClient
  .inputSchema(z.object({ id: z.string() }))
  .action(async ({ parsedInput }) => db.post.publish(parsedInput.id))
