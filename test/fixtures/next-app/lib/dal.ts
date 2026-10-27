import { cache } from 'react'
import { auth } from './auth'

export const getCurrentUserOrRedirect = cache(async () => {
  const session = await auth()
  if (!session) throw new Error('Unauthorized')
  return session.user
})
