import {
  OidcTokenRefresher,
  completeAuthorizationCodeGrant,
  discoverAndValidateOIDCIssuerWellKnown,
  generateOidcAuthorizationUrl,
} from 'matrix-js-sdk'
import { authConfig, getProductionConfigError } from '../matrix/config'

export const AUTH_SESSION_KEY = 'app-auth-session'
const AUTH_DATABASE_NAME = 'eprom-secure-session'
const AUTH_DATABASE_VERSION = 1
const AUTH_STORE = 'sessions'

export type AuthSession = {
  accessToken: string
  refreshToken?: string
  userId: string
  deviceId: string
  homeserverUrl: string
  issuer?: string
  clientId?: string
  idTokenClaims?: ConstructorParameters<typeof OidcTokenRefresher>[4]
}

function openAuthDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(AUTH_DATABASE_NAME, AUTH_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(AUTH_STORE)) database.createObjectStore(AUTH_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('AUTH_DATABASE_OPEN_FAILED'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('AUTH_DATABASE_TRANSACTION_FAILED'))
    transaction.onabort = () => reject(transaction.error ?? new Error('AUTH_DATABASE_TRANSACTION_ABORTED'))
  })
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<AuthSession>
  return typeof session.accessToken === 'string' && Boolean(session.accessToken)
    && typeof session.userId === 'string' && Boolean(session.userId)
    && typeof session.deviceId === 'string' && Boolean(session.deviceId)
    && typeof session.homeserverUrl === 'string' && Boolean(session.homeserverUrl)
}

async function readPersistentSession() {
  const database = await openAuthDatabase()
  try {
    const transaction = database.transaction(AUTH_STORE, 'readonly')
    const request = transaction.objectStore(AUTH_STORE).get(AUTH_SESSION_KEY)
    return await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('AUTH_DATABASE_READ_FAILED'))
    })
  } finally {
    database.close()
  }
}

export async function readAuthSession(): Promise<AuthSession | null> {
  if ('indexedDB' in window) {
    try {
      const persistent = await readPersistentSession()
      if (isAuthSession(persistent)) return persistent
      if (persistent) await clearAuthSession()
    } catch { /* Awaryjnie korzystamy z sesji bieżącego okna. */ }
  }

  const legacyValue = sessionStorage.getItem(AUTH_SESSION_KEY)
  if (!legacyValue) return null
  try {
    const legacySession: unknown = JSON.parse(legacyValue)
    if (!isAuthSession(legacySession)) throw new Error('INVALID_AUTH_SESSION')
    await saveAuthSession(legacySession)
    return legacySession
  } catch {
    await clearAuthSession()
    return null
  }
}

export async function saveAuthSession(session: AuthSession) {
  if ('indexedDB' in window) {
    try {
      const database = await openAuthDatabase()
      try {
        const transaction = database.transaction(AUTH_STORE, 'readwrite')
        transaction.objectStore(AUTH_STORE).put(session, AUTH_SESSION_KEY)
        await transactionComplete(transaction)
        sessionStorage.removeItem(AUTH_SESSION_KEY)
        return
      } finally {
        database.close()
      }
    } catch { /* Awaryjnie zachowujemy sesję do zamknięcia okna. */ }
  }
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session))
}

export async function clearAuthSession() {
  if ('indexedDB' in window) {
    try {
      const database = await openAuthDatabase()
      try {
        const transaction = database.transaction(AUTH_STORE, 'readwrite')
        transaction.objectStore(AUTH_STORE).delete(AUTH_SESSION_KEY)
        await transactionComplete(transaction)
      } finally {
        database.close()
      }
    } catch { /* Poniżej i tak czyścimy pamięć bieżącego okna. */ }
  }
  sessionStorage.removeItem(AUTH_SESSION_KEY)
  for (let index = sessionStorage.length - 1; index >= 0; index--) {
    const key = sessionStorage.key(index)
    if (key?.startsWith('mx_oidc_')) sessionStorage.removeItem(key)
  }
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function whoAmI(homeserverUrl: string, accessToken: string) {
  const response = await fetch(`${homeserverUrl.replace(/\/$/, '')}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw new Error('Nie udało się potwierdzić sesji')
  return response.json() as Promise<{ user_id: string, device_id?: string }>
}

export class AuthProvider {
  static isCallback() {
    const params = new URLSearchParams(window.location.search)
    return params.has('loginToken') || params.has('code') || params.has('error')
  }

  static getSsoLoginToken() {
    return new URLSearchParams(window.location.search).get('loginToken')
  }

  static async beginLogin() {
    if (getProductionConfigError()) throw new Error('AUTH_NOT_CONFIGURED')
    if (authConfig.matrixSsoEnabled) {
      const returnUrl = authConfig.redirectUri || `${window.location.origin}/`
      const server = authConfig.homeserverUrl.replace(/\/$/, '')
      const url = `${server}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(returnUrl)}`
      window.location.assign(url)
      return
    }
    const metadata = await discoverAndValidateOIDCIssuerWellKnown(authConfig.issuer)
    const url = await generateOidcAuthorizationUrl({
      metadata,
      redirectUri: authConfig.redirectUri,
      clientId: authConfig.clientId,
      homeserverUrl: authConfig.homeserverUrl,
      nonce: randomNonce(),
      prompt: 'login',
    })
    window.location.assign(url)
  }

  static async completeCallback(): Promise<AuthSession> {
    const params = new URLSearchParams(window.location.search)
    const providerError = params.get('error')
    if (providerError) throw new Error(providerError === 'access_denied' ? 'LOGIN_CANCELLED' : 'LOGIN_FAILED')
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) throw new Error('LOGIN_FAILED')

    const result = await completeAuthorizationCodeGrant(code, state)
    const identity = await whoAmI(result.homeserverUrl, result.tokenResponse.access_token)
    if (!identity.device_id) throw new Error('LOGIN_FAILED')
    const session: AuthSession = {
      accessToken: result.tokenResponse.access_token,
      refreshToken: result.tokenResponse.refresh_token,
      userId: identity.user_id,
      deviceId: identity.device_id,
      homeserverUrl: result.homeserverUrl,
      issuer: result.oidcClientSettings.issuer,
      clientId: result.oidcClientSettings.clientId,
      idTokenClaims: result.idTokenClaims,
    }
    await saveAuthSession(session)
    window.history.replaceState({}, document.title, '/')
    return session
  }
}

export class SessionTokenRefresher extends OidcTokenRefresher {
  override async persistTokens(tokens: { accessToken: string, refreshToken?: string }) {
    const session = await readAuthSession()
    if (session) await saveAuthSession({ ...session, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? session.refreshToken })
  }
}
