import type { MatrixClient } from 'matrix-js-sdk'
import type { IPusherRequest } from 'matrix-js-sdk/lib/@types/PushRules'

const PUSH_APP_ID = 'pl.webspanner.eprom.web'
const PUSH_GATEWAY_URL = 'http://push-gateway:8790/_matrix/push/v1/notify'

function gatewayBaseUrl(homeserverUrl: string) {
  return `${homeserverUrl.replace(/\/$/, '')}/_eprom/push`
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  return Uint8Array.from(raw, character => character.charCodeAt(0))
}

function accessHeaders(client: MatrixClient) {
  const accessToken = client.getAccessToken()
  if (!accessToken) throw new Error('PUSH_SESSION_MISSING')
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
}

export function pushNotificationsSupported() {
  return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window
}

export function pushPermission() {
  return 'Notification' in window ? Notification.permission : 'default'
}

export async function browserHasPushSubscription() {
  if (!pushNotificationsSupported()) return false
  const registration = await navigator.serviceWorker.ready
  return Boolean(await registration.pushManager.getSubscription())
}

export async function enablePushNotifications(client: MatrixClient, homeserverUrl: string) {
  if (!pushNotificationsSupported()) throw new Error('PUSH_NOT_SUPPORTED')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('PUSH_PERMISSION_DENIED')

  const registration = await navigator.serviceWorker.ready
  const keyResponse = await fetch(`${gatewayBaseUrl(homeserverUrl)}/public-key`, { cache: 'no-store' })
  const keyResult = await keyResponse.json().catch(() => ({})) as { publicKey?: string }
  if (!keyResponse.ok || !keyResult.publicKey) throw new Error('PUSH_SERVICE_UNAVAILABLE')

  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyResult.publicKey),
    })
  }

  const deviceId = client.getDeviceId()
  if (!deviceId) throw new Error('PUSH_SESSION_MISSING')
  const registerResponse = await fetch(`${gatewayBaseUrl(homeserverUrl)}/subscriptions`, {
    method: 'POST',
    headers: accessHeaders(client),
    body: JSON.stringify({ deviceId, subscription: subscription.toJSON() }),
  })
  const registerResult = await registerResponse.json().catch(() => ({})) as { pushKey?: string }
  if (!registerResponse.ok || !registerResult.pushKey) throw new Error('PUSH_SERVICE_UNAVAILABLE')

  await client.setPusher({
    app_display_name: 'Komunikator E-Prom',
    app_id: PUSH_APP_ID,
    append: true,
    data: { format: 'event_id_only', url: PUSH_GATEWAY_URL },
    device_display_name: 'Powiadomienia w telefonie',
    kind: 'http',
    lang: 'pl',
    pushkey: registerResult.pushKey,
  })
  return registerResult.pushKey
}

export async function disablePushNotifications(client: MatrixClient, homeserverUrl: string, pushKey: string) {
  if (pushKey) {
    await client.setPusher({ app_id: PUSH_APP_ID, kind: null, pushkey: pushKey } as unknown as IPusherRequest)
    await fetch(`${gatewayBaseUrl(homeserverUrl)}/subscriptions`, {
      method: 'DELETE',
      headers: accessHeaders(client),
      body: JSON.stringify({ pushKey }),
    })
  }
  if (pushNotificationsSupported()) {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) await subscription.unsubscribe()
  }
}

export function friendlyPushError(reason: unknown) {
  const code = reason instanceof Error ? reason.message : ''
  if (code === 'PUSH_NOT_SUPPORTED') return 'Ta przeglądarka nie obsługuje powiadomień. Na iPhonie najpierw dodaj aplikację do ekranu początkowego.'
  if (code === 'PUSH_PERMISSION_DENIED') return 'Powiadomienia są zablokowane w ustawieniach telefonu lub przeglądarki.'
  if (code === 'PUSH_SESSION_MISSING') return 'Sesja wygasła. Zaloguj się ponownie i spróbuj jeszcze raz.'
  return 'Nie udało się włączyć powiadomień. Sprawdź połączenie i spróbuj ponownie.'
}
