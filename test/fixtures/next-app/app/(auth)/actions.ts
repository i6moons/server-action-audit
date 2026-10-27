'use server'

import { signIn } from '@/lib/auth-provider'

// The login form must work without a session. @public-action
export async function login(formData: FormData) {
  await signIn('credentials', formData)
}
