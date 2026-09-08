import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const synapseUrl = process.env.SYNAPSE_URL || 'http://synapse:8008'
const secretFile = process.env.REGISTRATION_SHARED_SECRET_FILE || '/data/registration-helper-secret'
const accessCodeFile = process.env.REGISTRATION_ACCESS_CODE_FILE || '/data/registration-access-code'
const invitationsFile = process.env.REGISTRATION_INVITATIONS_FILE || '/data/registration-invitations.json'
const port = Number(process.env.PORT || 8787)
const invitationLifetime = 7 * 24 * 60 * 60 * 1000
const attempts = new Map()
let invitationsQueue = Promise.resolve()

function reply(response, status, body) {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function phoneLocalpart(value) {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) throw new Error('INVALID_PHONE')
  return `phone_${digits}`
}

function allowed(ip) {
  const now = Date.now()
  const recent = (attempts.get(ip) || []).filter(time => now - time < 60_000)
  recent.push(now)
  attempts.set(ip, recent)
  return recent.length <= 10
}

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 4096) throw new Error('BODY_TOO_LARGE')
  }
  return JSON.parse(body)
}

function invitationHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

async function readInvitations() {
  try {
    const parsed = JSON.parse(await readFile(invitationsFile, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
}

async function saveInvitations(records) {
  const temporaryFile = `${invitationsFile}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryFile, invitationsFile)
}

function updateInvitations(action) {
  const operation = invitationsQueue.then(async () => {
    const records = await readInvitations()
    const result = await action(records)
    await saveInvitations(records.filter(record => Number(record.expiresAt) > Date.now() - invitationLifetime))
    return result
  })
  invitationsQueue = operation.then(() => undefined, () => undefined)
  return operation
}

async function authenticatedUser(request) {
  const authorization = String(request.headers.authorization || '')
  if (!authorization.startsWith('Bearer ')) return ''
  const whoami = await fetch(`${synapseUrl}/_matrix/client/v3/account/whoami`, { headers: { authorization } })
  if (!whoami.ok) return ''
  const identity = await whoami.json()
  return typeof identity.user_id === 'string' ? identity.user_id : ''
}

function localpartFromUserId(userId) {
  const match = /^@([^:]+):/.exec(userId)
  return match?.[1] || ''
}

async function createInvitation(request, response) {
  const inviterUserId = await authenticatedUser(request)
  if (!inviterUserId) { reply(response, 401, { error: 'UNAUTHORIZED' }); return }
  const token = randomBytes(24).toString('base64url')
  const now = Date.now()
  const expiresAt = now + invitationLifetime
  await updateInvitations(records => {
    const activeForUser = records
      .filter(record => record.inviterUserId === inviterUserId && !record.claimedBy && Number(record.expiresAt) > now)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    const retainedHashes = new Set(activeForUser.slice(0, 19).map(record => record.tokenHash))
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]
      if (record.inviterUserId === inviterUserId && !record.claimedBy && Number(record.expiresAt) > now && !retainedHashes.has(record.tokenHash)) records.splice(index, 1)
    }
    records.push({ tokenHash: invitationHash(token), inviterUserId, createdAt: now, expiresAt })
  })
  reply(response, 201, { token, expiresAt })
}

async function reserveInvitation(token, username) {
  const hash = invitationHash(token)
  return updateInvitations(records => {
    const record = records.find(item => item.tokenHash === hash)
    if (!record || record.claimedBy || Number(record.expiresAt) <= Date.now()) throw new Error('INVITE_INVALID')
    if (record.registeredUsername && record.registeredUsername !== username) throw new Error('INVITE_INVALID')
    record.registeredUsername = username
    return record
  })
}

async function releaseInvitation(token, username) {
  const hash = invitationHash(token)
  await updateInvitations(records => {
    const record = records.find(item => item.tokenHash === hash)
    if (record && !record.claimedBy && record.registeredUsername === username) delete record.registeredUsername
  })
}

async function claimInvitation(request, response) {
  const userId = await authenticatedUser(request)
  if (!userId) { reply(response, 401, { error: 'UNAUTHORIZED' }); return }
  const { inviteToken } = await readJson(request)
  if (typeof inviteToken !== 'string' || inviteToken.length < 20 || inviteToken.length > 200) {
    reply(response, 400, { error: 'INVITE_INVALID' })
    return
  }
  const hash = invitationHash(inviteToken)
  try {
    const invitation = await updateInvitations(records => {
      const record = records.find(item => item.tokenHash === hash)
      if (!record || Number(record.expiresAt) <= Date.now() || record.inviterUserId === userId) throw new Error('INVITE_INVALID')
      if (record.claimedBy && record.claimedBy !== userId) throw new Error('INVITE_INVALID')
      if (record.registeredUsername && record.registeredUsername !== localpartFromUserId(userId)) throw new Error('INVITE_INVALID')
      record.claimedBy = userId
      record.claimedAt ||= Date.now()
      return record
    })
    reply(response, 200, { inviterUserId: invitation.inviterUserId })
  } catch (error) {
    if (error instanceof Error && error.message === 'INVITE_INVALID') { reply(response, 403, { error: 'INVITE_INVALID' }); return }
    throw error
  }
}

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { reply(response, 204, {}); return }
  const path = new URL(request.url || '/', 'http://registration.local').pathname
  if (request.method === 'POST' && path === '/invites') {
    try { await createInvitation(request, response) }
    catch (error) { console.error(error); reply(response, 503, { error: 'SERVICE_UNAVAILABLE' }) }
    return
  }
  if (request.method === 'POST' && path === '/invites/claim') {
    try { await claimInvitation(request, response) }
    catch (error) { console.error(error); reply(response, 503, { error: 'SERVICE_UNAVAILABLE' }) }
    return
  }
  if (request.method !== 'POST' || path !== '/register') { reply(response, 404, { error: 'NOT_FOUND' }); return }
  const ip = String(request.headers['cf-connecting-ip'] || request.headers['x-real-ip'] || request.socket.remoteAddress || '')
  if (!allowed(ip)) { reply(response, 429, { error: 'TOO_MANY_ATTEMPTS' }); return }

  let invitationReservation = null
  try {
    const { phone, password, accessCode, inviteToken } = await readJson(request)
    const username = phoneLocalpart(phone)
    if (typeof password !== 'string' || password.length < 4 || password.length > 128) {
      reply(response, 400, { error: 'WEAK_PASSWORD' })
      return
    }

    if (typeof inviteToken === 'string' && inviteToken) {
      try {
        await reserveInvitation(inviteToken, username)
        invitationReservation = { token: inviteToken, username }
      } catch (error) {
        if (error instanceof Error && error.message === 'INVITE_INVALID') { reply(response, 403, { error: 'INVITE_INVALID' }); return }
        throw error
      }
    } else {
      const requiredAccessCode = (await readFile(accessCodeFile, 'utf8')).trim()
      if (typeof accessCode !== 'string' || accessCode !== requiredAccessCode) {
        reply(response, 403, { error: 'ACCESS_DENIED' })
        return
      }
    }

    const sharedSecret = (await readFile(secretFile, 'utf8')).trim()
    const nonceResponse = await fetch(`${synapseUrl}/_synapse/admin/v1/register`)
    if (!nonceResponse.ok) throw new Error('NONCE_FAILED')
    const { nonce } = await nonceResponse.json()
    const mac = createHmac('sha1', sharedSecret)
      .update(`${nonce}\0${username}\0${password}\0notadmin`)
      .digest('hex')
    const registrationResponse = await fetch(`${synapseUrl}/_synapse/admin/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, username, password, admin: false, mac }),
    })
    const result = await registrationResponse.json()
    if (registrationResponse.ok) { reply(response, 201, { created: true }); return }
    if (invitationReservation) {
      await releaseInvitation(invitationReservation.token, invitationReservation.username)
      invitationReservation = null
    }
    if (result.errcode === 'M_USER_IN_USE') { reply(response, 409, { error: 'ACCOUNT_EXISTS' }); return }
    reply(response, 400, { error: 'REGISTRATION_FAILED' })
  } catch (error) {
    if (invitationReservation) {
      try { await releaseInvitation(invitationReservation.token, invitationReservation.username) }
      catch (releaseError) { console.error(releaseError) }
    }
    const known = error instanceof Error ? error.message : ''
    if (known === 'INVALID_PHONE' || known === 'BODY_TOO_LARGE' || error instanceof SyntaxError) {
      reply(response, 400, { error: 'INVALID_REQUEST' })
      return
    }
    console.error(error)
    reply(response, 503, { error: 'SERVICE_UNAVAILABLE' })
  }
}).listen(port, '0.0.0.0', () => console.log(`Registration helper listening on port ${port}`))
