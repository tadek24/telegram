import { Attachment } from '@matrix-org/matrix-sdk-crypto-wasm'
import { createClient, EventType, MsgType, Preset, type MatrixClient } from 'matrix-js-sdk'
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events'
import { IndexedDBStore } from 'matrix-js-sdk/lib/store/indexeddb'
import { clearAuthSession, readAuthSession, saveAuthSession, SessionTokenRefresher, type AuthSession } from '../auth/provider'
import { authConfig } from './config'
import { phoneToLocalpart, phoneToUserId } from './phone-identity'

let matrixClient: MatrixClient | null = null

export const GROUP_INVITE_EVENT = 'pl.webspanner.eprom.group_invite'

export async function hasStoredSession() { return await readAuthSession() !== null }

function cryptoDatabasePrefix(session: AuthSession) {
  const server = new URL(session.homeserverUrl).host
  return `eprom-${server}-${session.userId}-${session.deviceId}`.replace(/[^a-z0-9_-]/gi, '_')
}

function syncDatabaseName(session: AuthSession) {
  const server = new URL(session.homeserverUrl).host
  return `eprom-sync-${server}-${session.userId}-${session.deviceId}`.replace(/[^a-z0-9_-]/gi, '_')
}

async function startFromSession(session: AuthSession) {
  if (matrixClient) return matrixClient
  let tokenRefreshFunction: ((refreshToken: string) => Promise<{ accessToken: string, refreshToken?: string, expiry?: Date }>) | undefined
  if (session.refreshToken && session.issuer && session.clientId && session.idTokenClaims) {
    const refresher = new SessionTokenRefresher(session.issuer, session.clientId, authConfig.redirectUri, session.deviceId, session.idTokenClaims)
    await refresher.oidcClientReady
    tokenRefreshFunction = token => refresher.doRefreshAccessToken(token)
  }
  const syncStore = 'indexedDB' in window ? new IndexedDBStore({
    indexedDB: window.indexedDB,
    dbName: syncDatabaseName(session),
  }) : undefined
  matrixClient = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenRefreshFunction,
    userId: session.userId,
    deviceId: session.deviceId,
    store: syncStore,
  })
  try {
    if (syncStore) await syncStore.startup()
    await matrixClient.initRustCrypto({ cryptoDatabasePrefix: cryptoDatabasePrefix(session) })
    await matrixClient.startClient({ initialSyncLimit: 30 })
    return matrixClient
  } catch (error) {
    matrixClient.stopClient(); matrixClient = null
    throw error
  }
}

export async function restoreMessagingSession() {
  const session = await readAuthSession()
  return session ? startFromSession(session) : null
}

export async function startAuthenticatedClient(session: AuthSession) { return startFromSession(session) }

export async function loginWithDevelopmentPassword(username: string, password: string) {
  if (!authConfig.devLoginEnabled) throw new Error('DEV_LOGIN_DISABLED')
  if (matrixClient) return matrixClient
  matrixClient = createClient({ baseUrl: authConfig.homeserverUrl })
  try {
    const result = await matrixClient.login('m.login.password', { user: username.trim(), password })
    const session: AuthSession = { accessToken: result.access_token, userId: result.user_id, deviceId: result.device_id, homeserverUrl: authConfig.homeserverUrl }
    await saveAuthSession(session)
    matrixClient.stopClient(); matrixClient = null
    return await startFromSession(session)
  } catch (error) {
    matrixClient?.stopClient(); matrixClient = null; await clearAuthSession()
    throw error
  }
}

async function registerPhoneAccount(phone: string, password: string, accessCode: string) {
  const response = await fetch(`${authConfig.homeserverUrl.replace(/\/$/, '')}/_eprom/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password, accessCode }),
  })
  if (response.status === 201) return
  const result = await response.json().catch(() => ({})) as { error?: string }
  if (response.status === 409 || result.error === 'ACCOUNT_EXISTS') throw new Error('INVALID_CREDENTIALS')
  if (result.error === 'WEAK_PASSWORD') throw new Error('WEAK_PASSWORD')
  if (result.error === 'ACCESS_DENIED') throw new Error('ACCESS_DENIED')
  if (response.status === 429) throw new Error('TOO_MANY_ATTEMPTS')
  throw new Error('REGISTRATION_UNAVAILABLE')
}

export async function loginWithPhonePassword(phone: string, password: string, accessCode = '', allowRegistration = true): Promise<MatrixClient> {
  if (!authConfig.phoneMatrixLoginEnabled || !authConfig.homeserverUrl) throw new Error('PHONE_LOGIN_DISABLED')
  if (!password) throw new Error('INVALID_CREDENTIALS')
  if (matrixClient) return matrixClient
  matrixClient = createClient({ baseUrl: authConfig.homeserverUrl })
  try {
    const result = await matrixClient.login('m.login.password', {
      identifier: { type: 'm.id.user', user: phoneToLocalpart(phone) },
      password,
      initial_device_display_name: 'Komunikatr E-Prom',
    })
    const session: AuthSession = {
      accessToken: result.access_token,
      userId: result.user_id,
      deviceId: result.device_id,
      homeserverUrl: authConfig.homeserverUrl,
    }
    await saveAuthSession(session)
    matrixClient.stopClient(); matrixClient = null
    return await startFromSession(session)
  } catch (error) {
    matrixClient?.stopClient(); matrixClient = null; await clearAuthSession()
    if (typeof error === 'object' && error && 'errcode' in error && error.errcode === 'M_FORBIDDEN') {
      if (allowRegistration) {
        await registerPhoneAccount(phone, password, accessCode)
        return loginWithPhonePassword(phone, password, '', false)
      }
      throw new Error('INVALID_CREDENTIALS')
    }
    throw error
  }
}

export async function loginWithSsoToken(token: string) {
  if (!authConfig.matrixSsoEnabled || !token) throw new Error('SSO_LOGIN_DISABLED')
  if (matrixClient) return matrixClient
  matrixClient = createClient({ baseUrl: authConfig.homeserverUrl })
  try {
    const result = await matrixClient.login('m.login.token', {
      token,
      initial_device_display_name: 'Komunikatr E-Prom',
    })
    const session: AuthSession = {
      accessToken: result.access_token,
      userId: result.user_id,
      deviceId: result.device_id,
      homeserverUrl: authConfig.homeserverUrl,
    }
    await saveAuthSession(session)
    matrixClient.stopClient(); matrixClient = null
    return await startFromSession(session)
  } catch (error) {
    matrixClient?.stopClient(); matrixClient = null; await clearAuthSession()
    throw error
  }
}

export async function createEncryptedDirectRoom(userId: string) {
  if (!matrixClient) throw new Error('CLIENT_NOT_READY')
  const { room_id } = await matrixClient.createRoom({
    is_direct: true, invite: [userId], preset: Preset.TrustedPrivateChat,
    initial_state: [{ type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
  })
  return room_id
}

export async function createEncryptedDirectRoomByPhone(phone: string) {
  if (!matrixClient) throw new Error('CLIENT_NOT_READY')
  const serverName = matrixClient.getDomain()
  if (!serverName) throw new Error('SERVER_NOT_READY')
  return createEncryptedDirectRoom(phoneToUserId(phone, serverName))
}

export async function createEncryptedGroup(name: string) {
  if (!matrixClient) throw new Error('CLIENT_NOT_READY')
  const { room_id } = await matrixClient.createRoom({
    name: name.trim(),
    preset: Preset.PrivateChat,
    power_level_content_override: {
      users_default: 0,
      events_default: 0,
      state_default: 100,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 50,
      events: {
        [EventType.RoomName]: 100,
        [EventType.RoomAvatar]: 100,
        [EventType.RoomJoinRules]: 100,
        [EventType.RoomPowerLevels]: 100,
        [GROUP_INVITE_EVENT]: 100,
      },
    },
    initial_state: [{ type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
  })
  return room_id
}

export function normalizeGroupCode(value: string) {
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (code.length !== 8) throw new Error('GROUP_CODE_INVALID')
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function groupCodeToAlias(code: string, serverName: string) {
  const normalized = normalizeGroupCode(code).replace('-', '').toLowerCase()
  const domain = serverName.trim()
  if (!domain) throw new Error('SERVER_NOT_READY')
  return `#eprom_${normalized}:${domain}`
}

export async function joinGroup(invitation: string) {
  if (!matrixClient) throw new Error('CLIENT_NOT_READY')
  const trimmed = invitation.trim()
  let roomAddress = trimmed
  try {
    const invitationUrl = new URL(trimmed)
    roomAddress = invitationUrl.searchParams.get('join')?.trim() || trimmed
  } catch { /* Użytkownik może wkleić kod albo starszy identyfikator pokoju. */ }
  if (!roomAddress.startsWith('!') && !roomAddress.startsWith('#')) {
    const serverName = matrixClient.getDomain()
    if (!serverName) throw new Error('SERVER_NOT_READY')
    roomAddress = groupCodeToAlias(roomAddress, serverName)
  }
  const room = await matrixClient.joinRoom(roomAddress)
  return room.roomId
}

function messageTypeForFile(file: File) {
  if (file.type.startsWith('image/')) return MsgType.Image
  if (file.type.startsWith('video/')) return MsgType.Video
  if (file.type.startsWith('audio/')) return MsgType.Audio
  return MsgType.File
}

export async function sendMediaAttachment(
  roomId: string,
  source: File,
  caption: string,
  onProgress: (percent: number) => void,
) {
  if (!matrixClient) throw new Error('CLIENT_NOT_READY')
  const commonContent = {
    msgtype: messageTypeForFile(source),
    body: caption.trim() || source.name,
    filename: source.name,
    info: { mimetype: source.type || 'application/octet-stream', size: source.size },
  }
  const progressHandler = ({ loaded, total }: { loaded: number, total: number }) => {
    if (total > 0) onProgress(Math.min(100, Math.round((loaded / total) * 100)))
  }

  if (matrixClient.isRoomEncrypted(roomId)) {
    const encrypted = Attachment.encrypt(new Uint8Array(await source.arrayBuffer()))
    try {
      const encryptionInfo = encrypted.mediaEncryptionInfo
      if (!encryptionInfo) throw new Error('ATTACHMENT_ENCRYPTION_FAILED')
      const encryptedBytes = Uint8Array.from(encrypted.encryptedData)
      const upload = await matrixClient.uploadContent(new Blob([encryptedBytes.buffer]), {
        type: 'application/octet-stream',
        includeFilename: false,
        progressHandler,
      })
      await matrixClient.sendMessage(roomId, {
        ...commonContent,
        file: { ...JSON.parse(encryptionInfo), url: upload.content_uri },
      } as RoomMessageEventContent)
    } finally {
      encrypted.free()
    }
  } else {
    const upload = await matrixClient.uploadContent(source, {
      type: source.type || 'application/octet-stream',
      name: source.name,
      progressHandler,
    })
    await matrixClient.sendMessage(roomId, { ...commonContent, url: upload.content_uri } as RoomMessageEventContent)
  }
  onProgress(100)
}

export async function logoutMessaging() {
  const client = matrixClient
  matrixClient = null
  try { client?.stopClient(); if (client) await client.logout(true) }
  finally { await clearAuthSession() }
}
