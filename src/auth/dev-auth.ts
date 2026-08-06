import { loginWithDevelopmentPassword } from '../matrix/client'

export async function developmentLogin(username: string, password: string) {
  return loginWithDevelopmentPassword(username, password)
}
