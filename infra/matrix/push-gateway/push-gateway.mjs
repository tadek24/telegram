import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import webpush from 'web-push'

const port = Number(process.env.PORT || 8790)
const synapseUrl = process.env.SYNAPSE_URL || 'http://synapse:8008'
const dataFile = process.env.PUSH_SUBSCRIPTIONS_FILE || '/data/web-push-subscriptions.json'
const vapidFile = process.env.VAPID_KEYS_FILE || '/data/web-push-vapid.json'
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:push@webspanner.pl'
const recentEvents = new Map()
let subscriptions = []
let saveQueue = Promise.resolve()

function reply(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  response.end(status === 204 ? undefined : JSON.stringify(body))
}

async function readJson(request, limit = 32_768) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > limit) throw new Error('BODY_TOO_LARGE')
  }
  return body ? JSON.parse(body) : {}
}

async function readOrCreateVapidKeys() {
  try {
    const saved = JSON.parse(await readFile(vapidFile, 'utf8'))
    if (saved.publicKey && saved.privateKey) return saved
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const keys = webpush.generateVAPIDKeys()
  await mkdir(dirname(vapidFile), { recursive: true })
  await writeFile(vapidFile, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return keys
}

async function loadSubscriptions() {
  try {
    const saved = JSON.parse(await readFile(dataFile, 'utf8'))
    subscriptions = Array.isArray(saved) ? saved : []
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    subscriptions = []
  }
}

function persistSubscriptions() {
  const snapshot = JSON.stringify(subscriptions, null, 2)
  saveQueue = saveQueue.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true })
    const temporaryFile = `${dataFile}.new`
    await writeFile(temporaryFile, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryFile, dataFile)
  })
  return saveQueue
}

async function authenticatedUser(request) {
  const authorization = String(request.headers.authorization || '')
  if (!authorization.startsWith('Bearer ')) return null
  const response = await fetch(`${synapseUrl}/_matrix/client/v3/account/whoami`, {
    headers: { authorization },
  })
  if (!response.ok) return null
  const result = await response.json()
  return typeof result.user_id === 'string' ? result.user_id : null
}

function validSubscription(value) {
  return value && typeof value.endpoint === 'string' && value.endpoint.startsWith('https://')
    && typeof value.keys?.p256dh === 'string' && typeof value.keys?.auth === 'string'
}

function pruneRecentEvents() {
  const oldestAllowed = Date.now() - 10 * 60_000
  for (const [eventId, timestamp] of recentEvents) {
    if (timestamp < oldestAllowed) recentEvents.delete(eventId)
  }
}

async function registerSubscription(request, response) {
  const userId = await authenticatedUser(request)
  if (!userId) { reply(response, 401, { error: 'UNAUTHORIZED' }); return }
  const body = await readJson(request)
  if (!validSubscription(body.subscription) || typeof body.deviceId !== 'string' || !body.deviceId) {
    reply(response, 400, { error: 'INVALID_SUBSCRIPTION' })
    return
  }

  const existing = subscriptions.find(item => item.subscription?.endpoint === body.subscription.endpoint)
  const sameDevice = existing?.userId === userId && existing?.deviceId === body.deviceId
  const pushKey = sameDevice ? existing.pushKey : randomBytes(32).toString('base64url')
  subscriptions = subscriptions.filter(item => item.subscription?.endpoint !== body.subscription.endpoint && item.pushKey !== pushKey)
  subscriptions.push({
    pushKey,
    userId,
    deviceId: body.deviceId,
    subscription: body.subscription,
    updatedAt: new Date().toISOString(),
  })
  await persistSubscriptions()
  reply(response, 201, { pushKey })
}

async function deleteSubscription(request, response) {
  const userId = await authenticatedUser(request)
  if (!userId) { reply(response, 401, { error: 'UNAUTHORIZED' }); return }
  const { pushKey } = await readJson(request)
  if (typeof pushKey !== 'string' || !pushKey) { reply(response, 400, { error: 'INVALID_REQUEST' }); return }
  const before = subscriptions.length
  subscriptions = subscriptions.filter(item => !(item.userId === userId && item.pushKey === pushKey))
  if (subscriptions.length !== before) await persistSubscriptions()
  reply(response, 204, {})
}

async function notify(request, response) {
  const { notification } = await readJson(request, 128_000)
  if (!notification || !Array.isArray(notification.devices)) {
    reply(response, 400, { rejected: [] })
    return
  }

  pruneRecentEvents()
  const eventId = typeof notification.event_id === 'string' ? notification.event_id : ''
  if (eventId && recentEvents.has(eventId)) { reply(response, 200, { rejected: [] }); return }
  if (eventId) recentEvents.set(eventId, Date.now())

  const rejected = []
  let changed = false
  for (const device of notification.devices) {
    const pushKey = typeof device.pushkey === 'string' ? device.pushkey : ''
    const saved = subscriptions.find(item => item.pushKey === pushKey)
    if (!saved) { if (pushKey) rejected.push(pushKey); continue }
    try {
      await webpush.sendNotification(saved.subscription, JSON.stringify({
        title: 'Komunikator E-Prom',
        body: 'Masz nową wiadomość.',
        tag: eventId || `eprom-${Date.now()}`,
        data: { url: '/' },
      }), { TTL: 3600, urgency: 'high' })
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0)
      if (statusCode === 404 || statusCode === 410) {
        subscriptions = subscriptions.filter(item => item.pushKey !== pushKey)
        rejected.push(pushKey)
        changed = true
      } else {
        console.error(`Nie udało się dostarczyć powiadomienia (${statusCode || 'brak kodu'}).`)
      }
    }
  }
  if (changed) await persistSubscriptions()
  reply(response, 200, { rejected })
}

const vapidKeys = await readOrCreateVapidKeys()
await loadSubscriptions()
webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey)

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') { reply(response, 204, {}); return }
  try {
    const path = new URL(request.url || '/', 'http://localhost').pathname
    if (request.method === 'GET' && path === '/public-key') { reply(response, 200, { publicKey: vapidKeys.publicKey }); return }
    if (request.method === 'GET' && path === '/health') { reply(response, 200, { ok: true }); return }
    if (request.method === 'POST' && path === '/subscriptions') { await registerSubscription(request, response); return }
    if (request.method === 'DELETE' && path === '/subscriptions') { await deleteSubscription(request, response); return }
    if (request.method === 'POST' && path === '/_matrix/push/v1/notify') { await notify(request, response); return }
    reply(response, 404, { error: 'NOT_FOUND' })
  } catch (error) {
    const known = error instanceof Error ? error.message : ''
    if (known === 'BODY_TOO_LARGE' || error instanceof SyntaxError) { reply(response, 400, { error: 'INVALID_REQUEST' }); return }
    console.error(error)
    reply(response, 503, { error: 'SERVICE_UNAVAILABLE' })
  }
}).listen(port, '0.0.0.0', () => console.log(`Web Push gateway listening on port ${port}`))
