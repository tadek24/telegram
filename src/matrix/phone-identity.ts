const MIN_PHONE_DIGITS = 9
const MAX_PHONE_DIGITS = 15

export function normalizePhoneNumber(value: string) {
  const digits = value.replace(/\D/g, '')
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    throw new Error('INVALID_PHONE_NUMBER')
  }
  return digits
}

export function phoneToLocalpart(value: string) {
  return `phone_${normalizePhoneNumber(value)}`
}

export function phoneToUserId(value: string, serverName: string) {
  const domain = serverName.trim()
  if (!domain) throw new Error('SERVER_NOT_READY')
  return `@${phoneToLocalpart(value)}:${domain}`
}
