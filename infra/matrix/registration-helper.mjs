import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'

const synapseUrl = process.env.SYNAPSE_URL || 'http://synapse:8008'
const secretFile = process.env.REGISTRATION_SHARED_SECRET_FILE || '/data/registration-helper-secret'
const accessCodeFile = process.env.REGISTRATION_ACCESS_CODE_FILE || '/data/registration-access-code'
const attempts = new Map()

function reply(response, status, body) {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'content-type',
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

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { reply(response, 204, {}); return }
  if (request.method !== 'POST' || request.url !== '/register') { reply(response, 404, { error: 'NOT_FOUND' }); return }
  const ip = String(request.headers['x-real-ip'] || request.socket.remoteAddress || '')
  if (!allowed(ip)) { reply(response, 429, { error: 'TOO_MANY_ATTEMPTS' }); return }

  try {
    const { phone, password, accessCode } = await readJson(request)
    const username = phoneLocalpart(phone)
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      reply(response, 400, { error: 'WEAK_PASSWORD' })
      return
    }

    const requiredAccessCode = (await readFile(accessCodeFile, 'utf8')).trim()
    if (typeof accessCode !== 'string' || accessCode !== requiredAccessCode) {
      reply(response, 403, { error: 'ACCESS_DENIED' })
      return
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
    if (result.errcode === 'M_USER_IN_USE') { reply(response, 409, { error: 'ACCOUNT_EXISTS' }); return }
    reply(response, 400, { error: 'REGISTRATION_FAILED' })
  } catch (error) {
    const known = error instanceof Error ? error.message : ''
    if (known === 'INVALID_PHONE' || known === 'BODY_TOO_LARGE' || error instanceof SyntaxError) {
      reply(response, 400, { error: 'INVALID_REQUEST' })
      return
    }
    console.error(error)
    reply(response, 503, { error: 'SERVICE_UNAVAILABLE' })
  }
}).listen(8787, '0.0.0.0', () => console.log('Registration helper listening on port 8787'))
