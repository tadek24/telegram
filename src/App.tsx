import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-wasm'
import { ClientEvent, EventType, JoinRule, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room, type RoomMember } from 'matrix-js-sdk'
import { AuthProvider, clearAuthSession, type AuthSession } from './auth/provider'
import { authConfig, getProductionConfigError } from './matrix/config'
import { phoneToUserId } from './matrix/phone-identity'
import { readLocalAccount, saveLocalAccount } from './demo/storage'
import {
  browserHasPushSubscription,
  disablePushNotifications,
  enablePushNotifications,
  friendlyPushError,
  pushNotificationsSupported,
  pushPermission,
} from './push-notifications'
import {
  createEncryptedDirectRoom,
  createEncryptedDirectRoomByPhone,
  createEncryptedGroup,
  GROUP_INVITE_EVENT,
  groupCodeToAlias,
  hasStoredSession,
  joinGroup,
  loginWithSsoToken,
  loginWithPhonePassword,
  logoutMessaging,
  restoreMessagingSession,
  sendMediaAttachment,
  startAuthenticatedClient,
} from './matrix/client'

type AppStatus = 'restoring' | 'logged-out' | 'syncing' | 'ready' | 'offline' | 'demo'
type IconName = 'search' | 'chat' | 'contacts' | 'files' | 'history' | 'settings' | 'logout' | 'send' | 'plus' | 'menu' | 'close' | 'lock' | 'attach' | 'camera' | 'image' | 'file'
type ChatTheme = 'system' | 'light' | 'dark' | 'blue'
type ServerContact = { id: string, name: string, phone: string, avatar?: string, roomId?: string }
type ServerProfile = { name: string, about: string, avatar?: string }
type ServerLocalSettings = { version: 1, contacts: ServerContact[], about: string, theme: ChatTheme, pushKey?: string }
type GroupInviteState = { active?: boolean, code?: string, alias?: string }
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed', platform: string }>
}

const DEMO_SESSION_KEY = 'communicator-demo-session'
const DEMO_CODE = '246810'
const INSTALL_GUIDE_KEY = 'eprom-install-guide-seen-v1'
const GROUP_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function generateGroupCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const value = Array.from(bytes, byte => GROUP_CODE_ALPHABET[byte % GROUP_CODE_ALPHABET.length]).join('')
  return `${value.slice(0, 4)}-${value.slice(4)}`
}

function matrixErrorCode(reason: unknown) {
  return typeof reason === 'object' && reason && 'errcode' in reason ? String(reason.errcode) : ''
}

function phoneFromUserId(userId: string) {
  const match = /^@phone_(\d+):/.exec(userId)
  return match ? `+${match[1]}` : ''
}

function sendGroupInviteState(client: MatrixClient, roomId: string, content: GroupInviteState) {
  const sendState = client.sendStateEvent as unknown as (room: string, eventType: string, value: GroupInviteState, stateKey: string) => Promise<unknown>
  return sendState.call(client, roomId, GROUP_INVITE_EVENT, content, '')
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></>,
    contacts: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></>,
    files: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a7 7 0 0 0-1.8-1L14.2 3h-4.4l-.4 3a7 7 0 0 0-1.8 1L5 6 3 9.4 5.1 11a7 7 0 0 0 0 2L3 14.6 5 18l2.6-1a7 7 0 0 0 1.8 1l.4 3h4.4l.4-3a7 7 0 0 0 1.8-1l2.6 1 2-3.4-2.1-1.6a7 7 0 0 0 .1-1Z"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>, lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    attach: <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9"/>,
    camera: <><path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3Z"/><circle cx="12" cy="13" r="3"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-5L5 20"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

function BrandIcon() {
  return <img src="/icons/eprom-icon-192.png" alt="" aria-hidden="true" />
}

function isInstalledApp() {
  const iosNavigator = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || iosNavigator.standalone === true
}

function shouldOpenInstallGuide() {
  if (isInstalledApp()) return false
  if (new URLSearchParams(window.location.search).get('install') === '1') return true
  try { return localStorage.getItem(INSTALL_GUIDE_KEY) !== '1' }
  catch { return true }
}

function InstallGuideArt({ platform }: { platform: 'android' | 'ios' }) {
  return <div className={`install-art ${platform}`} aria-hidden="true">
    <div className="install-phone">
      <span className="install-speaker" />
      <div className="install-browser-bar">
        <span className="browser-dot red" /><span className="browser-dot yellow" /><span className="browser-dot green" />
        <span className="browser-address">eprom</span>
        <b>{platform === 'android' ? '⋮' : '↑'}</b>
      </div>
      <div className="install-app-preview">
        <span className="install-app-icon"><BrandIcon /></span>
        <strong>Komunikator<br />E-Prom</strong>
      </div>
      <div className="install-menu-preview">
        <span>{platform === 'android' ? '＋' : '□↑'}</span>
        <b>{platform === 'android' ? 'Zainstaluj aplikację' : 'Do ekranu początkowego'}</b>
      </div>
    </div>
  </div>
}

function InstallGuide({ installPrompt, shareStatus, onInstall, onShare, onClose }: { installPrompt: InstallPromptEvent | null, shareStatus: string, onInstall: () => void, onShare: () => void, onClose: () => void }) {
  return <div className="modal-layer install-guide-layer" role="presentation">
    <section className="install-guide-modal" role="dialog" aria-modal="true" aria-labelledby="install-guide-title">
      <button className="icon-button install-guide-close" type="button" onClick={onClose} aria-label="Zamknij instrukcję"><Icon name="close" /></button>
      <header className="install-guide-header">
        <span className="brand-mark small"><BrandIcon /></span>
        <div><p>PIERWSZE URUCHOMIENIE</p><h2 id="install-guide-title">Dodaj komunikator do telefonu</h2></div>
      </header>
      <p className="install-guide-lead">Aplikacja może działać jak zwykła aplikacja z ikoną na ekranie telefonu. Instalacja jest bezpłatna i nie wymaga sklepu Google Play ani App Store.</p>
      <div className="install-platform-grid">
        <article className="install-platform-card android">
          <div className="install-platform-title"><span>G</span><div><strong>Android</strong><small>przeglądarka Google Chrome</small></div></div>
          <InstallGuideArt platform="android" />
          <ol>
            <li>Otwórz tę stronę w <strong>Google Chrome</strong>.</li>
            <li>Naciśnij menu <strong>⋮</strong> w prawym górnym rogu.</li>
            <li>Wybierz <strong>„Zainstaluj aplikację”</strong> lub <strong>„Dodaj do ekranu głównego”</strong>.</li>
            <li>Potwierdź przyciskiem <strong>„Zainstaluj”</strong>.</li>
          </ol>
          {installPrompt && <button className="install-now-button" type="button" onClick={onInstall}>Zainstaluj teraz</button>}
        </article>
        <article className="install-platform-card ios">
          <div className="install-platform-title"><span>●</span><div><strong>iPhone / iPad</strong><small>przeglądarka Safari</small></div></div>
          <InstallGuideArt platform="ios" />
          <ol>
            <li>Otwórz tę stronę w <strong>Safari</strong>.</li>
            <li>Naciśnij ikonę udostępniania <strong>□↑</strong> na dole ekranu.</li>
            <li>Przewiń listę i wybierz <strong>„Do ekranu początkowego”</strong>.</li>
            <li>Naciśnij <strong>„Dodaj”</strong> w prawym górnym rogu.</li>
          </ol>
        </article>
      </div>
      <footer className="install-guide-footer">
        <p><Icon name="lock" /><span><strong>Po instalacji</strong> Otwórz ikonę aplikacji i zaloguj się numerem telefonu oraz własnym PIN-em. Kod dostępu jest potrzebny tylko podczas tworzenia nowego konta.</span></p>
        <div className="install-guide-actions">
          <button className="secondary-button" type="button" onClick={onShare}>{shareStatus || 'Udostępnij link instalacyjny'}</button>
          <button className="primary-button" type="button" onClick={onClose}>Przejdź do logowania</button>
        </div>
      </footer>
    </section>
  </div>
}

function friendlyError(error: unknown) {
  if (import.meta.env.DEV) console.error(error)
  const errorCode = typeof error === 'object' && error && 'errcode' in error ? String(error.errcode) : ''
  const code = `${errorCode} ${error instanceof Error ? error.message : ''}`
  if (code === 'LOGIN_CANCELLED') return 'Logowanie zostało anulowane.'
  if (code === 'AUTH_NOT_CONFIGURED') return 'Logowanie jest obecnie konfigurowane'
  if (code === 'INVALID_PHONE_NUMBER') return 'Wpisz poprawny numer telefonu z numerem kierunkowym kraju.'
  if (code.includes('INVALID_CREDENTIALS')) return 'Nieprawidłowy numer telefonu lub PIN.'
  if (code.includes('WEAK_PASSWORD')) return 'PIN lub hasło musi mieć co najmniej 8 znaków.'
  if (code.includes('TOO_MANY_ATTEMPTS')) return 'Zbyt wiele prób. Odczekaj minutę i spróbuj ponownie.'
  if (code.includes('REGISTRATION_UNAVAILABLE')) return 'Nie udało się utworzyć konta. Spróbuj ponownie później.'
  if (code.includes('ACCESS_DENIED')) return 'Nieprawidłowy kod dostępu. Poproś zaufaną osobę o aktualny kod.'
  if (code.includes('M_NOT_FOUND')) return 'Nie znaleziono użytkownika o tym numerze telefonu.'
  if (code.includes('M_FORBIDDEN')) return 'Nie masz uprawnień do tej operacji albo zaproszenie nie jest już aktywne.'
  if (code === 'PHONE_LOGIN_DISABLED' || code === 'SERVER_NOT_READY') return 'Usługa jest obecnie niedostępna.'
  if (code.includes('Failed to fetch') || code.includes('Network')) return 'Nie udało się połączyć. Sprawdź internet i spróbuj ponownie.'
  return 'Nie udało się wykonać tej operacji. Spróbuj ponownie.'
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat('pl', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function imageAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('IMAGE_REQUIRED')); return }
    if (file.size > 3 * 1024 * 1024) { reject(new Error('IMAGE_TOO_LARGE')); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('IMAGE_READ_FAILED'))
    reader.readAsDataURL(file)
  })
}

function AttachmentMenu({ disabled, onSelect }: { disabled?: boolean, onSelect: (file: File) => void }) {
  const [open, setOpen] = useState(false)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const documentRef = useRef<HTMLInputElement>(null)

  function selected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setOpen(false)
    if (file) onSelect(file)
  }

  return <div className="attachment-control">
    <button className="attachment-button" type="button" disabled={disabled} onClick={() => setOpen(current => !current)} aria-label="Dodaj zdjęcie, film lub dokument" aria-expanded={open}><Icon name="attach" /></button>
    {open && <div className="attachment-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => galleryRef.current?.click()}><span className="attachment-option image"><Icon name="image" /></span><span><strong>Zdjęcie lub film</strong><small>Wybierz z telefonu</small></span></button>
      <button type="button" role="menuitem" onClick={() => cameraRef.current?.click()}><span className="attachment-option camera"><Icon name="camera" /></span><span><strong>Aparat</strong><small>Zrób nowe zdjęcie</small></span></button>
      <button type="button" role="menuitem" onClick={() => documentRef.current?.click()}><span className="attachment-option document"><Icon name="file" /></span><span><strong>Dokument</strong><small>PDF, Office, ZIP i inne</small></span></button>
    </div>}
    <input className="hidden-file-input" ref={galleryRef} type="file" accept="image/*,video/*" onChange={selected} />
    <input className="hidden-file-input" ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={selected} />
    <input className="hidden-file-input" ref={documentRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,audio/*" onChange={selected} />
  </div>
}

function AttachmentPreview({ file, previewUrl, progress, onClear }: { file: File, previewUrl: string, progress: number, onClear: () => void }) {
  return <section className="attachment-preview" aria-label="Wybrany załącznik">
    {file.type.startsWith('image/') && previewUrl ? <img src={previewUrl} alt="Podgląd załącznika" /> : file.type.startsWith('video/') && previewUrl ? <video src={previewUrl} muted /> : <span className="file-preview-icon"><Icon name="file" /></span>}
    <div><strong>{file.name}</strong><small>{progress > 0 ? `Wysyłanie ${progress}%` : formatFileSize(file.size)}</small>{progress > 0 && <span className="upload-progress"><i style={{ width: `${progress}%` }} /></span>}</div>
    <button type="button" onClick={onClear} disabled={progress > 0 && progress < 100} aria-label="Usuń załącznik"><Icon name="close" /></button>
  </section>
}

function ExpandableImage({ src, name }: { src: string, name: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button className="media-thumbnail-button" type="button" onClick={() => setOpen(true)} aria-label={`Otwórz zdjęcie ${name}`}><img className="message-media" src={src} alt={name} loading="lazy" /></button>
    {open && <div className="media-viewer" role="dialog" aria-modal="true" aria-label={`Podgląd zdjęcia ${name}`} onClick={() => setOpen(false)}>
      <button className="media-viewer-close" type="button" onClick={() => setOpen(false)} aria-label="Zamknij podgląd"><Icon name="close" /></button>
      <img src={src} alt={name} onClick={event => event.stopPropagation()} />
      <a href={src} download={name} onClick={event => event.stopPropagation()}><Icon name="file" /> Pobierz</a>
    </div>}
  </>
}

type MatrixMediaContent = {
  body?: string
  filename?: string
  msgtype?: string
  url?: string
  file?: { url: string, key: { alg: string, key_ops: string[], kty: string, k: string, ext: boolean }, iv: string, hashes: Record<string, string>, v: string }
  info?: { mimetype?: string, size?: number }
}

function MatrixMedia({ content, client }: { content: MatrixMediaContent, client: MatrixClient }) {
  const [objectUrl, setObjectUrl] = useState('')
  const [loadError, setLoadError] = useState(false)
  const name = content.filename || content.body || 'Załącznik'
  const mimeType = content.info?.mimetype || 'application/octet-stream'

  useEffect(() => {
    let active = true
    let createdUrl = ''
    async function load() {
      const mxcUrl = content.file?.url || content.url
      if (!mxcUrl) return
      const httpUrl = client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, false, true)
      if (!httpUrl) return
      try {
        const accessToken = client.getAccessToken()
        const response = await fetch(httpUrl, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined })
        if (!response.ok) throw new Error('MEDIA_DOWNLOAD_FAILED')
        let blob: Blob
        if (content.file) {
          const encryptedBytes = new Uint8Array(await response.arrayBuffer())
          const encrypted = new EncryptedAttachment(encryptedBytes, JSON.stringify(content.file))
          try { blob = new Blob([Uint8Array.from(Attachment.decrypt(encrypted)).buffer], { type: mimeType }) }
          finally { encrypted.free() }
        } else blob = await response.blob()
        if (!active) return
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      } catch {
        if (active) setLoadError(true)
      }
    }
    void load()
    return () => { active = false; if (createdUrl) URL.revokeObjectURL(createdUrl) }
  }, [client, content.file, content.url, mimeType])

  if (loadError) return <span className="media-error">Nie udało się wczytać załącznika.</span>
  if (!objectUrl) return <span className="media-loading"><span className="spinner" /> Wczytywanie załącznika…</span>
  if (content.msgtype === 'm.image') return <ExpandableImage src={objectUrl} name={name} />
  if (content.msgtype === 'm.video') return <video className="message-media" src={objectUrl} controls preload="metadata" />
  if (content.msgtype === 'm.audio') return <audio className="message-audio" src={objectUrl} controls preload="metadata" />
  return <a className="message-file" href={objectUrl} download={name}><span><Icon name="file" /></span><span><b>{name}</b><small>{content.info?.size ? formatFileSize(content.info.size) : 'Dokument'}</small></span></a>
}

function useAuthenticatedMxc(client: MatrixClient | null | undefined, mxcUrl: string | undefined, width = 96, height = 96) {
  const [objectUrl, setObjectUrl] = useState('')

  useEffect(() => {
    let active = true
    let createdUrl = ''
    setObjectUrl('')
    if (!client || !mxcUrl) return () => { active = false }

    async function load() {
      try {
        const httpUrl = client!.mxcUrlToHttp(mxcUrl!, width, height, 'crop', false, false, true)
        if (!httpUrl) throw new Error('AVATAR_URL_UNAVAILABLE')
        const accessToken = client!.getAccessToken()
        const response = await fetch(httpUrl, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined })
        if (!response.ok) throw new Error('AVATAR_DOWNLOAD_FAILED')
        createdUrl = URL.createObjectURL(await response.blob())
        if (active) setObjectUrl(createdUrl)
        else URL.revokeObjectURL(createdUrl)
      } catch (reason) {
        if (import.meta.env.DEV) console.error(reason)
      }
    }

    void load()
    return () => {
      active = false
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [client, height, mxcUrl, width])

  return objectUrl
}

function ServerAvatar({ name, source, client, className = 'room-avatar', size = 96 }: { name: string, source?: string, client?: MatrixClient | null, className?: string, size?: number }) {
  const mxcUrl = source?.startsWith('mxc://') ? source : undefined
  const authenticatedSource = useAuthenticatedMxc(client, mxcUrl, size, size)
  const imageSource = mxcUrl ? authenticatedSource : source
  const [failedSource, setFailedSource] = useState('')
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '#'

  return imageSource && imageSource !== failedSource
    ? <img className={className} src={imageSource} alt="" onError={() => setFailedSource(imageSource)} />
    : <span className={className}>{initials}</span>
}

function roomTimestamp(room: Room) {
  return room.getLiveTimeline().getEvents().at(-1)?.getTs() ?? 0
}

function Login({ initialError = '', onDemoLogin, onAuthenticated }: { initialError?: string, onDemoLogin: (phone: string) => void, onAuthenticated: (client: MatrixClient) => void }) {
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [phone, setPhone] = useState('+48 ')
  const [code, setCode] = useState('')
  const [demoStep, setDemoStep] = useState<'phone' | 'code'>('phone')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [installGuideOpen, setInstallGuideOpen] = useState(shouldOpenInstallGuide)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [installShareStatus, setInstallShareStatus] = useState('')
  const configMessage = getProductionConfigError()
  const showPhoneLogin = authConfig.phoneMatrixLoginEnabled && !configMessage
  const showDemoLogin = Boolean(!showPhoneLogin && configMessage && authConfig.demoModeEnabled)

  useEffect(() => {
    function rememberPrompt(event: Event) {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    function installed() {
      setInstallPrompt(null)
      closeInstallGuide()
    }
    window.addEventListener('beforeinstallprompt', rememberPrompt)
    window.addEventListener('appinstalled', installed)
    return () => {
      window.removeEventListener('beforeinstallprompt', rememberPrompt)
      window.removeEventListener('appinstalled', installed)
    }
  }, [])

  function closeInstallGuide() {
    setInstallGuideOpen(false)
    try { localStorage.setItem(INSTALL_GUIDE_KEY, '1') } catch { /* Prywatny tryb może blokować zapis. */ }
    const url = new URL(window.location.href)
    if (url.searchParams.has('install')) {
      url.searchParams.delete('install')
      window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
    }
  }

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    setInstallPrompt(null)
    if (choice.outcome === 'accepted') closeInstallGuide()
  }

  async function shareInstallLink() {
    const installUrl = new URL('/', window.location.origin)
    installUrl.searchParams.set('install', '1')
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Komunikator E-Prom', text: 'Otwórz link i zainstaluj komunikator E-Prom na telefonie.', url: installUrl.toString() })
        setInstallShareStatus('Link udostępniony')
      } else {
        await navigator.clipboard.writeText(installUrl.toString())
        setInstallShareStatus('Link skopiowany')
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      try {
        await navigator.clipboard.writeText(installUrl.toString())
        setInstallShareStatus('Link skopiowany')
      } catch { setInstallShareStatus('Nie udało się skopiować linku') }
    }
  }

  async function beginLogin() {
    setBusy(true); setError('')
    try { await AuthProvider.beginLogin() }
    catch (reason) { setError(friendlyError(reason)); setBusy(false) }
  }

  async function submitDev(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const { developmentLogin } = await import('./auth/dev-auth')
      await developmentLogin(user, password)
      setPassword('')
      window.location.reload()
    } catch (reason) {
      setPassword('')
      setError(friendlyError(reason))
    } finally { setBusy(false) }
  }

  async function submitPhoneLogin(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const nextClient = await loginWithPhonePassword(phone, password, accessCode)
      setPassword('')
      onAuthenticated(nextClient)
    } catch (reason) {
      setPassword('')
      setError(friendlyError(reason))
    } finally { setBusy(false) }
  }

  function submitDemo(event: FormEvent) {
    event.preventDefault()
    setError('')
    if (demoStep === 'phone') {
      if (phone.replace(/\D/g, '').length < 9) {
        setError('Wpisz poprawny numer telefonu.')
        return
      }
      setDemoStep('code')
      return
    }
    if (code !== DEMO_CODE) {
      setError(`Demonstracyjny PIN to ${DEMO_CODE}.`)
      return
    }
    sessionStorage.setItem(DEMO_SESSION_KEY, phone.trim())
    onDemoLogin(phone.trim())
  }

  return <main className="login-page">
    <section className="login-card">
      <div className="brand-mark"><BrandIcon /></div>
      <p className="login-kicker">Twoje rozmowy w jednym miejscu</p>
      <h1>Witaj ponownie</h1>
      <p className="login-description">Zaloguj się bezpiecznie, aby przejść do swoich wiadomości.</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {showPhoneLogin ? <form className="demo-login-form" onSubmit={submitPhoneLogin}>
        <label>Numer telefonu<input autoFocus required type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+48 500 000 000" /></label>
        <label>PIN lub hasło<input required minLength={8} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
        <label>Kod dostępu <small>(tylko przy tworzeniu konta)</small><input type="password" autoComplete="off" value={accessCode} onChange={event => setAccessCode(event.target.value)} placeholder="Kod od zaufanej osoby" /></label>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Łączenie…' : 'Zaloguj się'}</button>
      </form> : showDemoLogin ? <form className="demo-login-form" onSubmit={submitDemo}>
        <p className="demo-label"><span /> Wersja demonstracyjna</p>
        {demoStep === 'phone' ? <label>Numer telefonu<input autoFocus required type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+48 500 000 000" /></label> : <>
          <button className="change-phone" type="button" onClick={() => { setDemoStep('phone'); setCode(''); setError('') }}>Zmień numer: {phone}</button>
          <label>Demonstracyjny PIN<input autoFocus required inputMode="numeric" autoComplete="off" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 cyfr" /></label>
          <p className="demo-code-note">Na potrzeby lokalnego podglądu wpisz PIN <strong>{DEMO_CODE}</strong>.</p>
        </>}
        <button className="primary-button" type="submit">{demoStep === 'phone' ? 'Dalej' : 'Zaloguj się'}</button>
      </form> : configMessage ? <p className="configuration-note">Logowanie jest obecnie konfigurowane</p> : <button className="primary-button login-action" onClick={beginLogin} disabled={busy}>{busy ? 'Przekierowanie…' : 'Zaloguj się'}</button>}
      {authConfig.devLoginEnabled && <details className="dev-login"><summary>Tryb testowy</summary><form onSubmit={submitDev}><label>Login<input required autoComplete="username" value={user} onChange={e => setUser(e.target.value)} /></label><label>Hasło testowe<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><button className="primary-button" disabled={busy}>Zaloguj testowo</button></form></details>}
      <p className="privacy-note">{showDemoLogin ? 'To lokalny PIN demonstracyjny. Profil, kontakty i rozmowy są zapisywane wyłącznie na tym urządzeniu.' : 'Połączenie jest chronione, a PIN nie jest zapisywany w przeglądarce.'}</p>
      {!isInstalledApp() && <button className="install-help-button" type="button" onClick={() => setInstallGuideOpen(true)}><span className="brand-mark small"><BrandIcon /></span><span><strong>Dodaj aplikację do telefonu</strong><small>Instrukcja dla Androida i iPhone’a</small></span><b>›</b></button>}
    </section>
    {installGuideOpen && <InstallGuide installPrompt={installPrompt} shareStatus={installShareStatus} onInstall={() => void installApp()} onShare={() => void shareInstallLink()} onClose={closeInstallGuide} />}
  </main>
}

export default function App() {
  const [status, setStatus] = useState<AppStatus>('restoring')
  const [demoPhone, setDemoPhone] = useState(() => sessionStorage.getItem(DEMO_SESSION_KEY) ?? '')
  const [client, setClient] = useState<MatrixClient | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [activeRoomId, setActiveRoomId] = useState('')
  const [messages, setMessages] = useState<MatrixEvent[]>([])
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [attachmentPreview, setAttachmentPreview] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [drawer, setDrawer] = useState(false)
  const [newChat, setNewChat] = useState(false)
  const [groupDialog, setGroupDialog] = useState<'create' | 'join' | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupInvitation, setGroupInvitation] = useState('')
  const [invitee, setInvitee] = useState('')
  const [people, setPeople] = useState<{ userId: string, name: string, avatar?: string }[]>([])
  const [selectedPerson, setSelectedPerson] = useState<{ userId: string, name: string } | null>(null)
  const [profile, setProfile] = useState<ServerProfile>({ name: 'Użytkownik', about: 'Dostępny' })
  const [accountDraft, setAccountDraft] = useState<ServerProfile>({ name: 'Użytkownik', about: 'Dostępny' })
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null)
  const [contacts, setContacts] = useState<ServerContact[]>([])
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactAvatar, setContactAvatar] = useState('')
  const [editingContactId, setEditingContactId] = useState('')
  const [contactsDialog, setContactsDialog] = useState(false)
  const [accountDialog, setAccountDialog] = useState(false)
  const [roomSettingsDialog, setRoomSettingsDialog] = useState(false)
  const [roomSettingsName, setRoomSettingsName] = useState('')
  const [roomSettingsAvatar, setRoomSettingsAvatar] = useState('')
  const [roomSettingsAvatarFile, setRoomSettingsAvatarFile] = useState<File | null>(null)
  const [roomSettingsAvatarRemoved, setRoomSettingsAvatarRemoved] = useState(false)
  const [roomSettingsContactIds, setRoomSettingsContactIds] = useState<string[]>([])
  const [roomSettingsCodeEnabled, setRoomSettingsCodeEnabled] = useState(false)
  const [roomSettingsCode, setRoomSettingsCode] = useState('')
  const [roomSettingsAlias, setRoomSettingsAlias] = useState('')
  const [roomSettingsSaved, setRoomSettingsSaved] = useState('')
  const [historyDialog, setHistoryDialog] = useState(false)
  const [filesDialog, setFilesDialog] = useState(false)
  const [theme, setTheme] = useState<ChatTheme>('system')
  const [pushKey, setPushKey] = useState('')
  const [pushBusy, setPushBusy] = useState(false)
  const [pushNotice, setPushNotice] = useState('')
  const [settingsHydrated, setSettingsHydrated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timelineRef = useRef<HTMLDivElement>(null)
  const appWasHidden = useRef(false)

  useEffect(() => () => {
    if (attachmentPreview) URL.revokeObjectURL(attachmentPreview)
  }, [attachmentPreview])

  function attachClient(nextClient: MatrixClient) {
    setClient(nextClient)
    setStatus('syncing')
  }

  useEffect(() => {
    const storedDemoPhone = sessionStorage.getItem(DEMO_SESSION_KEY)
    if (authConfig.demoModeEnabled && storedDemoPhone && getProductionConfigError()) {
      setDemoPhone(storedDemoPhone)
      setStatus('demo')
      return
    }
    const isAuthCallback = AuthProvider.isCallback()
    const restore = async () => {
      try {
        if (!isAuthCallback && !await hasStoredSession()) { setStatus('logged-out'); return }
        let restored: MatrixClient | null
        if (isAuthCallback) {
          const ssoToken = AuthProvider.getSsoLoginToken()
          if (ssoToken) {
            restored = await loginWithSsoToken(ssoToken)
            window.history.replaceState({}, document.title, '/')
          } else {
            const session: AuthSession = await AuthProvider.completeCallback()
            restored = await startAuthenticatedClient(session)
          }
        } else restored = await restoreMessagingSession()
        if (restored) attachClient(restored)
        else setStatus('logged-out')
      } catch (reason) {
        setError(friendlyError(reason))
        if (isAuthCallback) {
          await clearAuthSession()
          window.history.replaceState({}, document.title, '/')
        }
        setStatus('logged-out')
      }
    }
    void restore()
  }, [])

  useEffect(() => {
    if (!client) return
    const userId = client.getUserId()
    if (!userId) return
    Promise.all([client.getProfileInfo(userId), readLocalAccount<ServerLocalSettings>(userId)]).then(([info, local]) => {
      const remoteName = info.displayname?.trim()
      setProfile({
        name: remoteName && !/^phone_\d+$/.test(remoteName) && !remoteName.startsWith('@') ? remoteName : 'Użytkownik',
        about: local?.about || 'Dostępny',
        avatar: info.avatar_url || undefined,
      })
      if (local?.version === 1) {
        setContacts(local.contacts)
        setTheme(local.theme)
        const savedPushKey = local.pushKey || ''
        if (savedPushKey && pushPermission() === 'granted') {
          setPushKey(savedPushKey)
          void browserHasPushSubscription().then(active => { if (!active) setPushKey('') }).catch(() => setPushKey(''))
        }
      }
      setSettingsHydrated(true)
    }).catch(reason => { if (import.meta.env.DEV) console.error(reason); setSettingsHydrated(true) })
  }, [client])

  useEffect(() => {
    const userId = client?.getUserId()
    if (!userId || !settingsHydrated) return
    const timer = window.setTimeout(() => {
      void saveLocalAccount<ServerLocalSettings>(userId, { version: 1, contacts, about: profile.about, theme, pushKey })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [client, contacts, profile.about, pushKey, settingsHydrated, theme])

  useEffect(() => {
    if (!client) return
    const watchedEvents = new Set<MatrixEvent>()
    let initialRoomsReady = false
    const initialWaitStarted = Date.now()
    let commitTimer = 0
    let decryptionTimer = 0

    const commitRooms = () => {
      const nextRooms = client.getRooms().slice().sort((a, b) => roomTimestamp(b) - roomTimestamp(a))
      setRooms(nextRooms)
      setStatus(client.getSyncState() === 'ERROR' ? 'offline' : 'ready')
      setActiveRoomId(current => current && nextRooms.some(room => room.roomId === current && room.getMyMembership() === 'join') ? current : '')
      initialRoomsReady = true
    }

    const refresh = () => {
      const nextRooms = client.getRooms().slice().sort((a, b) => roomTimestamp(b) - roomTimestamp(a))
      const timelineEvents = nextRooms.flatMap(room => room.getLiveTimeline().getEvents())
      timelineEvents.forEach(event => {
        if (watchedEvents.has(event)) return
        watchedEvents.add(event)
        event.on(MatrixEventEvent.Decrypted, refresh)
      })

      const syncState = client.getSyncState()
      if (syncState === 'ERROR') { setStatus('offline'); return }
      if (!initialRoomsReady) {
        if (syncState !== 'PREPARED' && syncState !== 'SYNCING') { setStatus('syncing'); return }
        const pendingDecryption = timelineEvents.some(event => event.isEncrypted() && !event.getClearContent() && !event.isDecryptionFailure())
        if (pendingDecryption && Date.now() - initialWaitStarted < 6_000) {
          window.clearTimeout(decryptionTimer)
          decryptionTimer = window.setTimeout(refresh, 120)
          return
        }
        window.clearTimeout(commitTimer)
        commitTimer = window.setTimeout(commitRooms, 250)
        return
      }
      commitRooms()
    }
    client.on(ClientEvent.Sync, refresh)
    client.on(ClientEvent.Room, refresh)
    client.on(RoomEvent.Timeline, refresh)
    client.on(RoomEvent.MyMembership, refresh)
    const refreshTimer = window.setInterval(refresh, 2_000)
    refresh()
    return () => {
      client.off(ClientEvent.Sync, refresh)
      client.off(ClientEvent.Room, refresh)
      client.off(RoomEvent.Timeline, refresh)
      client.off(RoomEvent.MyMembership, refresh)
      window.clearTimeout(commitTimer)
      window.clearTimeout(decryptionTimer)
      window.clearInterval(refreshTimer)
      watchedEvents.forEach(event => event.off(MatrixEventEvent.Decrypted, refresh))
    }
  }, [client])

  useEffect(() => {
    if (!client) return
    const networkInformation = (navigator as Navigator & { connection?: EventTarget }).connection
    const saveSyncedState = () => { void client.store.save(true) }
    const reconnect = () => {
      if (!navigator.onLine) { setStatus('offline'); return }
      if (document.visibilityState === 'visible') {
        client.retryImmediately()
        setStatus(current => current === 'offline' ? 'syncing' : current)
      }
    }
    const returnToApp = () => reconnect()
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') {
        appWasHidden.current = true
        saveSyncedState()
        return
      }
      if (appWasHidden.current) {
        appWasHidden.current = false
        setActiveRoomId('')
      }
      reconnect()
    }
    window.addEventListener('online', reconnect)
    window.addEventListener('focus', returnToApp)
    window.addEventListener('pageshow', returnToApp)
    window.addEventListener('pagehide', saveSyncedState)
    document.addEventListener('visibilitychange', visibilityChanged)
    networkInformation?.addEventListener('change', reconnect)
    const timer = window.setInterval(reconnect, 10_000)
    return () => {
      window.removeEventListener('online', reconnect)
      window.removeEventListener('focus', returnToApp)
      window.removeEventListener('pageshow', returnToApp)
      window.removeEventListener('pagehide', saveSyncedState)
      document.removeEventListener('visibilitychange', visibilityChanged)
      networkInformation?.removeEventListener('change', reconnect)
      window.clearInterval(timer)
    }
  }, [client])

  const activeRoom = rooms.find(room => room.roomId === activeRoomId)

  useEffect(() => {
    if (!activeRoom) { setMessages([]); return }
    const watchedEvents = new Set<MatrixEvent>()
    const update = () => {
      const timelineEvents = activeRoom.getLiveTimeline().getEvents()
      timelineEvents.forEach(event => {
        if (watchedEvents.has(event)) return
        watchedEvents.add(event)
        event.on(MatrixEventEvent.Decrypted, update)
      })
      setMessages(timelineEvents.filter(event => event.getType() === EventType.RoomMessage))
    }
    activeRoom.on(RoomEvent.Timeline, update)
    update()
    return () => {
      activeRoom.off(RoomEvent.Timeline, update)
      watchedEvents.forEach(event => event.off(MatrixEventEvent.Decrypted, update))
    }
  }, [activeRoom])

  useEffect(() => { timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight }) }, [messages, activeRoomId])

  useEffect(() => {
    if (!client || (status !== 'ready' && status !== 'offline')) return
    const invitation = new URLSearchParams(window.location.search).get('join')
    if (!invitation || groupDialog) return
    setGroupInvitation(invitation)
    setGroupDialog('join')
  }, [client, groupDialog, status])

  const contactForRoom = (room: Room) => contacts.find(contact => contact.roomId === room.roomId)
  const displayRoomName = (room: Room) => contactForRoom(room)?.name ?? safeRoomName(room)
  const visibleRooms = useMemo(() => rooms.filter(room => {
    const contact = contacts.find(item => item.roomId === room.roomId)
    return (contact?.name ?? safeRoomName(room)).toLowerCase().includes(search.toLowerCase())
  }), [contacts, rooms, search])
  const allJoinedRooms = rooms.filter(room => room.getMyMembership() === 'join')
  const joinedRooms = visibleRooms.filter(room => room.getMyMembership() === 'join')
  const invitedRooms = visibleRooms.filter(room => room.getMyMembership() === 'invite')
  const myUserId = client?.getUserId() ?? ''
  const activeRoomIsGroup = Boolean(activeRoom && !isDirectRoom(client, activeRoom.roomId))
  const activeRoomIsAdmin = Boolean(activeRoomIsGroup && myUserId && (activeRoom?.getMember(myUserId)?.powerLevel ?? 0) >= 100)
  const activeGroupMembers = activeRoomIsGroup ? (activeRoom?.getMembers() ?? [])
    .filter(member => member.membership === 'join' || member.membership === 'invite')
    .sort((a, b) => b.powerLevel - a.powerLevel || groupMemberDisplayName(a, contacts, myUserId).localeCompare(groupMemberDisplayName(b, contacts, myUserId), 'pl')) : []
  const activeRoomMemberIds = new Set(activeRoom?.getMembers().filter(member => member.membership === 'join' || member.membership === 'invite').map(member => member.userId) ?? [])
  const groupInviteContacts = activeRoomIsGroup && client?.getDomain() ? contacts.filter(contact => {
    try { return !activeRoomMemberIds.has(phoneToUserId(contact.phone, client.getDomain()!)) }
    catch { return false }
  }) : []
  const mediaItems = allJoinedRooms.flatMap(room => room.getLiveTimeline().getEvents()
    .filter(event => event.getType() === EventType.RoomMessage && ['m.image', 'm.video', 'm.audio', 'm.file'].includes(event.getContent<{ msgtype?: string }>().msgtype ?? ''))
    .map(event => ({ room, event, name: event.getContent<{ body?: string, filename?: string }>().filename || event.getContent<{ body?: string }>().body || 'Załącznik' })))
    .sort((a, b) => b.event.getTs() - a.event.getTs())

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    if (!client || !activeRoom || (!body && !pendingFile)) return
    setError('')
    try {
      if (pendingFile) {
        setUploadProgress(1)
        await sendMediaAttachment(activeRoom.roomId, pendingFile, body, setUploadProgress)
        setPendingFile(null)
        setAttachmentPreview('')
        setUploadProgress(0)
      } else await client.sendTextMessage(activeRoom.roomId, body)
      setDraft('')
    } catch (reason) {
      setUploadProgress(0)
      setError(friendlyError(reason))
    }
  }

  function selectAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setError('Załącznik może mieć maksymalnie 25 MB.')
      return
    }
    setError('')
    setPendingFile(file)
    setUploadProgress(0)
    setAttachmentPreview(file.type.startsWith('image/') || file.type.startsWith('video/') ? URL.createObjectURL(file) : '')
  }

  function clearAttachment() {
    setPendingFile(null)
    setAttachmentPreview('')
    setUploadProgress(0)
  }

  async function createChat(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      if (authConfig.phoneMatrixLoginEnabled) {
        const roomId = await createEncryptedDirectRoomByPhone(invitee)
        setInvitee(''); setNewChat(false); setActiveRoomId(roomId)
        return
      }
      if (!selectedPerson) {
        if (!client || invitee.trim().length < 2) return
        const result = await client.searchUserDirectory({ term: invitee.trim(), limit: 8 })
        setPeople(result.results.map(person => ({ userId: person.user_id, name: person.display_name?.trim() || 'Użytkownik', avatar: person.avatar_url || undefined })))
        return
      }
      const roomId = await createEncryptedDirectRoom(selectedPerson.userId)
      setInvitee(''); setPeople([]); setSelectedPerson(null); setNewChat(false); setActiveRoomId(roomId)
    } catch (reason) { setError(friendlyError(reason)) }
    finally { setBusy(false) }
  }

  async function submitGroup(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const roomId = groupDialog === 'create'
        ? await createEncryptedGroup(groupName)
        : await joinGroup(groupInvitation)
      setActiveRoomId(roomId)
      setGroupName(''); setGroupInvitation(''); setGroupDialog(null)
      if (window.location.search) window.history.replaceState({}, document.title, window.location.pathname)
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : matrixErrorCode(reason)
      setError(code.includes('GROUP_CODE_INVALID') || code.includes('M_NOT_FOUND') || code.includes('M_FORBIDDEN')
        ? 'Kod grupy jest nieprawidłowy albo nie jest już aktywny.'
        : friendlyError(reason))
    }
    finally { setBusy(false) }
  }

  function openRoomSettings(room: Room) {
    if (!client) return
    const avatarMxc = room.getMxcAvatarUrl()
    const joinRule = room.currentState.getStateEvents(EventType.RoomJoinRules, '')?.getContent<{ join_rule?: string }>().join_rule
    const inviteState = room.currentState.getStateEvents(GROUP_INVITE_EVENT, '')?.getContent<GroupInviteState>() ?? {}
    setRoomSettingsName(displayRoomName(room))
    setRoomSettingsAvatar(avatarMxc ?? '')
    setRoomSettingsAvatarFile(null)
    setRoomSettingsAvatarRemoved(false)
    setRoomSettingsContactIds([])
    setRoomSettingsCodeEnabled(joinRule === 'public' && inviteState.active === true)
    setRoomSettingsCode(inviteState.code ?? '')
    setRoomSettingsAlias(inviteState.alias ?? '')
    setRoomSettingsSaved('')
    setRoomSettingsDialog(true)
  }

  async function selectRoomSettingsAvatar(file: File) {
    try {
      setRoomSettingsAvatar(await imageAsDataUrl(file))
      setRoomSettingsAvatarFile(file)
      setRoomSettingsAvatarRemoved(false)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error && reason.message === 'IMAGE_TOO_LARGE' ? 'Avatar może mieć maksymalnie 3 MB.' : 'Wybierz prawidłowy plik ze zdjęciem.')
    }
  }

  function toggleRoomContact(contactId: string) {
    setRoomSettingsContactIds(current => current.includes(contactId) ? current.filter(id => id !== contactId) : [...current, contactId])
  }

  async function createRoomJoinCode(roomId: string, domain: string) {
    if (!client) throw new Error('CLIENT_NOT_READY')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const code = generateGroupCode()
      const alias = groupCodeToAlias(code, domain)
      try {
        await client.createAlias(alias, roomId)
        return { code, alias }
      } catch (reason) {
        if (matrixErrorCode(reason) !== 'M_ROOM_IN_USE') throw reason
      }
    }
    throw new Error('GROUP_CODE_UNAVAILABLE')
  }

  async function saveRoomSettings(event: FormEvent) {
    event.preventDefault()
    if (!client || !activeRoom) return
    setBusy(true); setError(''); setRoomSettingsSaved('')
    try {
      if (activeRoomIsGroup) {
        if (!activeRoomIsAdmin) throw new Error('ADMIN_ONLY')
        const name = roomSettingsName.trim()
        if (name.length < 3) throw new Error('GROUP_NAME_TOO_SHORT')
        await client.setRoomName(activeRoom.roomId, name)
        if (roomSettingsAvatarFile) {
          const upload = await client.uploadContent(roomSettingsAvatarFile, { type: roomSettingsAvatarFile.type, name: roomSettingsAvatarFile.name })
          await client.sendStateEvent(activeRoom.roomId, EventType.RoomAvatar, { url: upload.content_uri }, '')
          setRoomSettingsAvatar(upload.content_uri)
          setRoomSettingsAvatarFile(null)
        } else if (roomSettingsAvatarRemoved) {
          await client.sendStateEvent(activeRoom.roomId, EventType.RoomAvatar, { url: '' }, '')
          setRoomSettingsAvatar('')
          setRoomSettingsAvatarRemoved(false)
        }
        const domain = client.getDomain()
        if (!domain) throw new Error('SERVER_NOT_READY')
        let code = roomSettingsCode
        let alias = roomSettingsAlias
        if (roomSettingsCodeEnabled) {
          if (!code || !alias) ({ code, alias } = await createRoomJoinCode(activeRoom.roomId, domain))
          await client.sendStateEvent(activeRoom.roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Public }, '')
          await sendGroupInviteState(client, activeRoom.roomId, { active: true, code, alias })
          setRoomSettingsCode(code)
          setRoomSettingsAlias(alias)
        } else {
          await client.sendStateEvent(activeRoom.roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Invite }, '')
          if (alias) {
            try { await client.deleteAlias(alias) }
            catch (reason) { if (matrixErrorCode(reason) !== 'M_NOT_FOUND') throw reason }
          }
          await sendGroupInviteState(client, activeRoom.roomId, { active: false })
          setRoomSettingsCode('')
          setRoomSettingsAlias('')
        }
        for (const contactId of roomSettingsContactIds) {
          const contact = contacts.find(item => item.id === contactId)
          if (contact) await client.invite(activeRoom.roomId, phoneToUserId(contact.phone, domain))
        }
        setRoomSettingsContactIds([])
        setRoomSettingsSaved('Ustawienia grupy zostały zapisane.')
      } else {
        const contact = contactForRoom(activeRoom)
        const name = roomSettingsName.trim()
        if (!name) throw new Error('CONTACT_NAME_REQUIRED')
        if (contact) setContacts(current => current.map(item => item.id === contact.id ? { ...item, name } : item))
        else {
          const otherMember = activeRoom.getMembers().find(member => member.userId !== myUserId)
          const phone = otherMember ? phoneFromUserId(otherMember.userId) : ''
          if (!phone) throw new Error('CONTACT_PHONE_UNAVAILABLE')
          setContacts(current => [{ id: crypto.randomUUID(), name, phone, roomId: activeRoom.roomId }, ...current])
        }
        setRoomSettingsSaved('Ustawienia rozmowy zostały zapisane.')
      }
    } catch (reason) {
      if (reason instanceof Error && reason.message === 'GROUP_NAME_TOO_SHORT') setError('Nazwa grupy musi mieć co najmniej 3 znaki.')
      else if (reason instanceof Error && reason.message === 'ADMIN_ONLY') setError('Tylko administrator może zmieniać ustawienia grupy.')
      else if (reason instanceof Error && reason.message === 'GROUP_CODE_UNAVAILABLE') setError('Nie udało się utworzyć kodu grupy. Spróbuj ponownie.')
      else if (reason instanceof Error && (reason.message === 'CONTACT_NAME_REQUIRED' || reason.message === 'CONTACT_PHONE_UNAVAILABLE')) setError('Nie udało się zapisać nazwy tej rozmowy.')
      else setError(friendlyError(reason))
    } finally { setBusy(false) }
  }

  async function copyGroupCode() {
    if (!roomSettingsCode) return
    try {
      await navigator.clipboard.writeText(roomSettingsCode)
      setRoomSettingsSaved('Kod grupy został skopiowany.')
    } catch { setError('Nie udało się skopiować kodu. Zaznacz go i skopiuj ręcznie.') }
  }

  async function shareGroupCode() {
    if (!roomSettingsCode) return
    if (navigator.share) {
      try { await navigator.share({ title: roomSettingsName || 'Zaproszenie do grupy', text: `Kod dołączenia do grupy E-Prom: ${roomSettingsCode}` }); return }
      catch { return }
    }
    await copyGroupCode()
  }

  async function deleteConversation() {
    if (!client || !activeRoom) return
    const name = displayRoomName(activeRoom)
    const warning = activeRoomIsGroup
      ? `Opuścić i usunąć grupę „${name}” ze swojej listy? Pozostali uczestnicy nadal będą mieli do niej dostęp.`
      : `Usunąć rozmowę „${name}” ze swojej listy? Druga osoba zachowa swoją kopię rozmowy.`
    if (!window.confirm(warning)) return
    setBusy(true); setError('')
    try {
      const roomId = activeRoom.roomId
      await client.leave(roomId)
      await client.forget(roomId, true)
      setContacts(current => current.map(contact => contact.roomId === roomId ? { ...contact, roomId: undefined } : contact))
      setRoomSettingsDialog(false)
      setActiveRoomId('')
    } catch (reason) { setError(friendlyError(reason)) }
    finally { setBusy(false) }
  }

  async function handleInvite(room: Room, accept: boolean) {
    if (!client) return
    setBusy(true); setError('')
    try {
      if (accept) { await client.joinRoom(room.roomId); setActiveRoomId(room.roomId) }
      else await client.leave(room.roomId)
    } catch (reason) { setError(friendlyError(reason)) }
    finally { setBusy(false) }
  }

  function resetServerContactForm() {
    setEditingContactId('')
    setContactName('')
    setContactPhone('')
    setContactAvatar('')
  }

  function editServerContact(contact: ServerContact) {
    setEditingContactId(contact.id)
    setContactName(contact.name)
    setContactPhone(contact.phone)
    setContactAvatar(contact.avatar ?? '')
  }

  async function selectServerContactAvatar(file: File) {
    try { setContactAvatar(await imageAsDataUrl(file)); setError('') }
    catch (reason) { setError(reason instanceof Error && reason.message === 'IMAGE_TOO_LARGE' ? 'Avatar może mieć maksymalnie 3 MB.' : 'Wybierz prawidłowy plik ze zdjęciem.') }
  }

  function saveServerContact(event: FormEvent) {
    event.preventDefault()
    const name = contactName.trim()
    const phone = contactPhone.trim()
    if (!name || !phone) return
    const existing = contacts.find(contact => contact.id === editingContactId)
    const contact: ServerContact = {
      id: editingContactId || crypto.randomUUID(),
      name,
      phone,
      avatar: contactAvatar || undefined,
      roomId: existing?.roomId,
    }
    setContacts(current => editingContactId
      ? current.map(item => item.id === editingContactId ? contact : item)
      : [contact, ...current])
    resetServerContactForm()
  }

  function removeServerContact(contact: ServerContact) {
    if (!window.confirm(`Usunąć kontakt „${contact.name}”? Rozmowa i wiadomości pozostaną bez zmian.`)) return
    setContacts(current => current.filter(item => item.id !== contact.id))
    if (editingContactId === contact.id) resetServerContactForm()
  }

  async function openServerContactConversation(contact: ServerContact) {
    setBusy(true); setError('')
    try {
      const existingRoom = contact.roomId ? rooms.find(room => room.roomId === contact.roomId && room.getMyMembership() === 'join') : undefined
      const roomId = existingRoom?.roomId ?? await createEncryptedDirectRoomByPhone(contact.phone)
      if (!existingRoom) setContacts(current => current.map(item => item.id === contact.id ? { ...item, roomId } : item))
      setActiveRoomId(roomId)
      setContactsDialog(false)
      setDrawer(false)
    } catch (reason) { setError(friendlyError(reason)) }
    finally { setBusy(false) }
  }

  function openServerAccountSettings() {
    setAccountDraft(profile)
    setProfileAvatarFile(null)
    setPushNotice('')
    setAccountDialog(true)
    setDrawer(false)
  }

  async function togglePushNotifications() {
    if (!client) return
    setPushBusy(true)
    setPushNotice('')
    try {
      if (pushKey) {
        await disablePushNotifications(client, authConfig.homeserverUrl, pushKey)
        setPushKey('')
        setPushNotice('Powiadomienia zostały wyłączone na tym urządzeniu.')
      } else {
        const nextPushKey = await enablePushNotifications(client, authConfig.homeserverUrl)
        setPushKey(nextPushKey)
        setPushNotice('Powiadomienia są włączone na tym urządzeniu.')
      }
    } catch (reason) {
      setPushNotice(friendlyPushError(reason))
    } finally {
      setPushBusy(false)
    }
  }

  async function selectServerProfileAvatar(file: File) {
    try {
      const preview = await imageAsDataUrl(file)
      setProfileAvatarFile(file)
      setAccountDraft(current => ({ ...current, avatar: preview }))
      setError('')
    } catch (reason) { setError(reason instanceof Error && reason.message === 'IMAGE_TOO_LARGE' ? 'Avatar może mieć maksymalnie 3 MB.' : 'Wybierz prawidłowy plik ze zdjęciem.') }
  }

  async function saveServerAccountSettings(event: FormEvent) {
    event.preventDefault()
    if (!client) return
    const name = accountDraft.name.trim()
    if (!name) return
    setBusy(true); setError('')
    try {
      await client.setDisplayName(name)
      let avatar = accountDraft.avatar
      if (profileAvatarFile) {
        const upload = await client.uploadContent(profileAvatarFile, { type: profileAvatarFile.type, name: profileAvatarFile.name })
        await client.setAvatarUrl(upload.content_uri)
        avatar = upload.content_uri
      } else if (profile.avatar && !accountDraft.avatar) {
        await client.setAvatarUrl('')
        avatar = undefined
      }
      setProfile({ name, about: accountDraft.about.trim(), avatar })
      setProfileAvatarFile(null)
      setAccountDialog(false)
    } catch (reason) { setError(friendlyError(reason)) }
    finally { setBusy(false) }
  }

  async function logout() {
    setBusy(true)
    const userId = client?.getUserId()
    if (client && pushKey) {
      try {
        await disablePushNotifications(client, authConfig.homeserverUrl, pushKey)
        if (userId) await saveLocalAccount<ServerLocalSettings>(userId, { version: 1, contacts, about: profile.about, theme, pushKey: '' })
      } catch (reason) { if (import.meta.env.DEV) console.error(reason) }
      setPushKey('')
    }
    try { await logoutMessaging() } catch (reason) { if (import.meta.env.DEV) console.error(reason) }
    setClient(null); setRooms([]); setActiveRoomId(''); setStatus('logged-out'); setBusy(false)
  }

  if (status === 'restoring') return <main className="center-state"><span className="spinner"/><h1>Przywracamy bezpieczną sesję</h1><p>Przygotowujemy Twoje rozmowy…</p></main>
  if (status === 'logged-out') return <Login initialError={error} onAuthenticated={attachClient} onDemoLogin={phone => { setDemoPhone(phone); setStatus('demo') }} />
  if (status === 'demo') return <DemoWorkspace phone={demoPhone} onLogout={() => { sessionStorage.removeItem(DEMO_SESSION_KEY); setDemoPhone(''); setStatus('logged-out') }} />

  return <main className="workspace" data-chat-theme={theme}>
    {drawer && <button className="drawer-scrim" aria-label="Zamknij menu" onClick={() => setDrawer(false)} />}
    <aside className={`sidebar ${drawer ? 'open' : ''}`}>
      <header className="sidebar-brand">
        <span className="brand-mark small"><BrandIcon /></span><strong>Komunikatr E-Prom</strong>
        <button className="icon-button close-drawer" onClick={() => setDrawer(false)} aria-label="Zamknij menu"><Icon name="close"/></button>
      </header>
      <button className="user-card user-card-button" onClick={openServerAccountSettings}><ServerAvatar name={profile.name} source={profile.avatar} client={client} className="user-avatar"/><div><strong>{profile.name}</strong><small>{profile.about || 'Twoje konto'}</small></div></button>
      <nav className="side-nav" aria-label="Zasoby użytkownika">
        <button className="active" onClick={() => setDrawer(false)}><Icon name="chat"/><span>Wszystkie pokoje</span><b>{allJoinedRooms.length}</b></button>
        <button onClick={() => { setContactsDialog(true); setDrawer(false) }}><Icon name="contacts"/><span>Kontakty</span></button>
        <button onClick={() => { setFilesDialog(true); setDrawer(false) }}><Icon name="files"/><span>Pliki i media</span></button>
        <button onClick={() => { setHistoryDialog(true); setDrawer(false) }}><Icon name="history"/><span>Historia</span></button>
        <button onClick={openServerAccountSettings}><Icon name="settings"/><span>Ustawienia konta</span></button>
      </nav>
      <div className="sidebar-bottom">
        <p><span className={`status-dot ${status === 'ready' ? 'ready' : ''}`}/><strong>{status === 'offline' ? 'Brak połączenia' : status === 'syncing' ? 'Synchronizacja…' : 'Połączono'}</strong><small>{status === 'offline' ? 'Wiadomości mogą być nieaktualne' : 'Wiadomości są aktualne'}</small></p>
        <button className="logout-button" onClick={logout} disabled={busy}><Icon name="logout"/>Wyloguj się</button>
      </div>
    </aside>

    <section className="rooms-panel">
      <header className="rooms-header">
        <button className="mobile-logo" onClick={() => setDrawer(true)} aria-label="Otwórz menu"><BrandIcon /></button>
        <div><span>Twoje konto</span><h1>Wiadomości</h1></div>
        <button className="new-chat-button" onClick={() => setNewChat(true)} aria-label="Nowa szyfrowana rozmowa"><Icon name="plus"/></button>
      </header>
      <label className="search"><Icon name="search"/><span className="sr-only">Szukaj pokoi</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Szukaj rozmowy"/></label>
      <div className="group-actions"><button onClick={() => setGroupDialog('create')}><Icon name="contacts"/>Utwórz grupę</button><button onClick={() => setGroupDialog('join')}><Icon name="plus"/>Dołącz do grupy</button></div>
      {settingsHydrated && !pushKey && pushNotificationsSupported() && <section className="push-reminder" aria-label="Powiadomienia"><div><strong>Nie przegap nowej wiadomości</strong><small>Włącz bezpieczne powiadomienia na tym urządzeniu. Treść rozmowy nie pojawi się na ekranie blokady.</small></div><button type="button" disabled={pushBusy} onClick={() => void togglePushNotifications()}>{pushBusy ? 'Włączanie…' : 'Włącz'}</button>{pushNotice && <p role="status">{pushNotice}</p>}</section>}
      {error && <p className="error-banner compact" role="alert">{error}<button onClick={() => setError('')} aria-label="Zamknij"><Icon name="close"/></button></p>}
      <div className="rooms-scroll">
        {invitedRooms.length > 0 && <section className="invites"><h2>Zaproszenia</h2>{invitedRooms.map(room => <article key={room.roomId}><RoomAvatar room={room} client={client}/><div><strong>{safeRoomName(room)}</strong><small>Zaproszenie do rozmowy</small><span><button disabled={busy} onClick={() => handleInvite(room, true)}>Dołącz</button><button disabled={busy} onClick={() => handleInvite(room, false)}>Odrzuć</button></span></div></article>)}</section>}
        <h2 className="list-title">Rozmowy <span>{joinedRooms.length}</span></h2>
        <div className="room-list">{joinedRooms.map(room => { const contact = contactForRoom(room); return <button key={room.roomId} className={room.roomId === activeRoomId ? 'active' : ''} onClick={() => setActiveRoomId(room.roomId)}>{contact ? <DemoAvatar name={contact.name} avatar={contact.avatar}/> : <RoomAvatar room={room} client={client}/>}<span><strong>{displayRoomName(room)}</strong><small>{lastMessage(room)}</small></span><time>{roomTimestamp(room) ? formatTime(roomTimestamp(room)) : ''}</time></button> })}</div>
        {status === 'syncing' ? <div className="rooms-loading" role="status"><span className="spinner"/><p>Przywracamy ostatnie wiadomości…</p></div> : joinedRooms.length === 0 && <div className="empty-list"><Icon name="chat"/><p>Nie masz jeszcze żadnych pokoi.</p><button onClick={() => setNewChat(true)}>Rozpocznij rozmowę</button></div>}
      </div>
    </section>

    <section className={`chat-panel ${activeRoom ? 'mobile-active' : ''}`}>
      {activeRoom ? <>
        <header className="chat-header"><button className="back-button" onClick={() => setActiveRoomId('')} aria-label="Wróć do rozmów">‹</button>{contactForRoom(activeRoom) ? <DemoAvatar name={contactForRoom(activeRoom)!.name} avatar={contactForRoom(activeRoom)!.avatar}/> : <RoomAvatar room={activeRoom} client={client}/>}<div><strong>{displayRoomName(activeRoom)}</strong><small><Icon name="lock"/> {activeRoomIsGroup ? `${activeGroupMembers.filter(member => member.membership === 'join').length} członków · grupa chroniona` : 'Rozmowa prywatna i chroniona'}</small></div><button className="chat-settings-button" type="button" onClick={() => openRoomSettings(activeRoom)} aria-label={activeRoomIsGroup ? activeRoomIsAdmin ? 'Ustawienia grupy' : 'Informacje o grupie' : 'Ustawienia rozmowy prywatnej'}><Icon name={activeRoomIsGroup && !activeRoomIsAdmin ? 'contacts' : 'settings'}/></button></header>
        <div className="timeline" ref={timelineRef}>{messages.length === 0 && <div className="conversation-empty"><Icon name="lock"/><h2>Bezpieczna rozmowa</h2><p>Napisz pierwszą wiadomość w tym pokoju.</p></div>}{messages.map(message => <Message key={message.getId() ?? `${message.getTs()}-${message.getSender()}`} event={message} room={activeRoom} client={client!} own={message.getSender() === myUserId}/>)}</div>
        <form className="composer" onSubmit={sendMessage}>
          {pendingFile && <AttachmentPreview file={pendingFile} previewUrl={attachmentPreview} progress={uploadProgress} onClear={clearAttachment} />}
          <div className="composer-row"><AttachmentMenu disabled={uploadProgress > 0} onSelect={selectAttachment} /><label><span className="sr-only">Treść wiadomości lub podpis załącznika</span><textarea rows={1} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }} placeholder={pendingFile ? 'Dodaj podpis…' : 'Napisz wiadomość…'}/></label><button disabled={(!draft.trim() && !pendingFile) || uploadProgress > 0} aria-label="Wyślij wiadomość"><Icon name="send"/></button></div>
        </form>
      </> : <div className="chat-placeholder"><span><Icon name="chat"/></span><h2>Wybierz rozmowę</h2><p>Otwórz pokój z listy lub rozpocznij nową, szyfrowaną rozmowę.</p><button onClick={() => setNewChat(true)}><Icon name="plus"/>Nowa rozmowa</button></div>}
    </section>

    {newChat && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-chat-title"><button className="icon-button modal-close" onClick={() => { setNewChat(false); setSelectedPerson(null); setPeople([]) }} aria-label="Zamknij"><Icon name="close"/></button><span className="modal-icon"><Icon name="lock"/></span><h2 id="new-chat-title">Nowa prywatna rozmowa</h2><p>{authConfig.phoneMatrixLoginEnabled ? 'Wpisz numer telefonu osoby, z którą chcesz rozpocząć chronioną rozmowę.' : 'Znajdź osobę, z którą chcesz rozpocząć chronioną rozmowę.'}</p><form onSubmit={createChat}><label>{authConfig.phoneMatrixLoginEnabled ? 'Numer telefonu' : 'Imię lub nazwa użytkownika'}<input autoFocus required type={authConfig.phoneMatrixLoginEnabled ? 'tel' : 'text'} inputMode={authConfig.phoneMatrixLoginEnabled ? 'tel' : undefined} value={selectedPerson?.name ?? invitee} onChange={e => { setInvitee(e.target.value); setSelectedPerson(null); setPeople([]) }} placeholder={authConfig.phoneMatrixLoginEnabled ? '+48 500 000 000' : 'Wpisz nazwę'}/></label>{!authConfig.phoneMatrixLoginEnabled && people.length > 0 && <div className="people-results">{people.map(person => <button type="button" key={person.userId} onClick={() => setSelectedPerson(person)}><ServerAvatar name={person.name} source={person.avatar} client={client} className="people-avatar" size={80}/><strong>{person.name}</strong></button>)}</div>}<button className="primary-button" disabled={busy}>{busy ? 'Proszę czekać…' : authConfig.phoneMatrixLoginEnabled || selectedPerson ? 'Rozpocznij rozmowę' : 'Znajdź osobę'}</button></form></section></div>}
    {groupDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="group-dialog-title"><button className="icon-button modal-close" onClick={() => setGroupDialog(null)} aria-label="Zamknij"><Icon name="close"/></button><span className="modal-icon"><Icon name="contacts"/></span><h2 id="group-dialog-title">{groupDialog === 'create' ? 'Utwórz nową grupę' : 'Dołącz do grupy'}</h2><p>{groupDialog === 'create' ? 'Nadaj grupie czytelną nazwę. Jako jej twórca zostaniesz jedynym administratorem.' : 'Wpisz krótki kod otrzymany od administratora grupy.'}</p><form onSubmit={submitGroup}>{groupDialog === 'create' ? <label>Nazwa grupy<input autoFocus required minLength={3} maxLength={60} value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="np. Zespół E-Prom"/></label> : <label>Kod grupy<input autoFocus required minLength={8} maxLength={12} autoCapitalize="characters" value={groupInvitation} onChange={event => setGroupInvitation(event.target.value.toUpperCase())} placeholder="np. 7KQF-9M2R"/></label>}<button className="primary-button" disabled={busy}>{busy ? 'Proszę czekać…' : groupDialog === 'create' ? 'Utwórz grupę' : 'Dołącz do grupy'}</button></form></section></div>}
    {roomSettingsDialog && activeRoom && <div className="modal-layer" role="presentation"><section className="modal room-settings-modal" role="dialog" aria-modal="true" aria-labelledby="room-settings-title">
      <button className="icon-button modal-close" onClick={() => setRoomSettingsDialog(false)} aria-label="Zamknij"><Icon name="close"/></button>
      <span className="modal-icon"><Icon name={activeRoomIsGroup ? 'contacts' : 'chat'}/></span><h2 id="room-settings-title">{activeRoomIsGroup ? activeRoomIsAdmin ? 'Ustawienia grupy' : 'Informacje o grupie' : 'Ustawienia rozmowy prywatnej'}</h2><p>{activeRoomIsGroup ? activeRoomIsAdmin ? 'Zarządzaj grupą, kodem dołączenia i zaproszeniami.' : 'Możesz zobaczyć członków grupy. Ustawienia zmienia wyłącznie jej administrator.' : 'Ustaw lokalną nazwę tej osoby albo usuń rozmowę ze swojej listy.'}</p>
      {activeRoomIsGroup ? <>
        <section className="group-members-section"><h3>Członkowie <span>{activeGroupMembers.length}</span></h3><div className="group-member-list">{activeGroupMembers.map(member => <GroupMemberRow key={member.userId} member={member} client={client!} contacts={contacts} myUserId={myUserId}/>)}</div></section>
        {activeRoomIsAdmin ? <form onSubmit={saveRoomSettings} className="group-admin-form">
          <p className="admin-badge">Administrator grupy</p>
          <div className="avatar-editor"><ServerAvatar name={roomSettingsName || 'Grupa'} source={roomSettingsAvatar} client={client}/><label className="secondary-button">Zmień avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectRoomSettingsAvatar(file); event.target.value = '' }}/></label>{roomSettingsAvatar && <button type="button" className="text-button" onClick={() => { setRoomSettingsAvatar(''); setRoomSettingsAvatarFile(null); setRoomSettingsAvatarRemoved(true) }}>Usuń zdjęcie</button>}</div>
          <label>Nazwa grupy<input required minLength={3} maxLength={60} value={roomSettingsName} onChange={event => setRoomSettingsName(event.target.value)} /></label>
          <label className="setting-toggle group-link-toggle"><span><strong>Kod umożliwiający dołączenie</strong><small>Osoba z aktywnym kodem i kontem w aplikacji będzie mogła dołączyć.</small></span><input type="checkbox" checked={roomSettingsCodeEnabled} onChange={event => { setRoomSettingsCodeEnabled(event.target.checked); setRoomSettingsSaved('') }}/></label>
          {roomSettingsCodeEnabled && <div className="group-invitation-box">{roomSettingsCode ? <><span className="group-code-label">Kod grupy</span><output className="group-code">{roomSettingsCode}</output><div><button type="button" className="secondary-button" onClick={() => void copyGroupCode()}>Kopiuj kod</button><button type="button" className="secondary-button" onClick={() => void shareGroupCode()}>Udostępnij</button></div><small>Przekazuj kod tylko osobom, które mają dołączyć.</small></> : <p>Kod zostanie wygenerowany po zapisaniu ustawień.</p>}</div>}
          <fieldset className="group-contacts-fieldset"><legend>Dodaj osoby z kontaktów</legend>{groupInviteContacts.length === 0 ? <p className="empty-dialog-note">Nie ma nowych kontaktów, które można zaprosić do tej grupy.</p> : <div className="group-contact-picker">{groupInviteContacts.map(contact => <label key={contact.id}><input type="checkbox" checked={roomSettingsContactIds.includes(contact.id)} onChange={() => toggleRoomContact(contact.id)}/><DemoAvatar name={contact.name} avatar={contact.avatar}/><span><strong>{contact.name}</strong><small>{contact.phone}</small></span></label>)}</div>}</fieldset>
          {roomSettingsSaved && <p className="success-banner" role="status">{roomSettingsSaved}</p>}
          <button className="primary-button" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz ustawienia grupy'}</button>
        </form> : <p className="admin-only-note"><Icon name="lock"/> Tylko osoba, która utworzyła grupę, może zmieniać jej nazwę, avatar, kod i zaproszenia.</p>}
        <section className="danger-zone"><h3>Opuść grupę</h3><p>Grupa zniknie z Twojego konta. Pozostali uczestnicy zachowają rozmowę.</p><button type="button" disabled={busy} onClick={() => void deleteConversation()}>Opuść i usuń grupę</button></section>
      </> : <>
        <section className="private-chat-summary"><RoomAvatar room={activeRoom} client={client}/><div><strong>{displayRoomName(activeRoom)}</strong><small><Icon name="lock"/> Prywatna rozmowa między dwiema osobami</small></div></section>
        <form onSubmit={saveRoomSettings} className="private-chat-form"><label>Lokalna nazwa kontaktu<input required maxLength={60} value={roomSettingsName} onChange={event => setRoomSettingsName(event.target.value)} /></label><p className="local-storage-note">Ta nazwa jest widoczna tylko w tej przeglądarce i nie zmienia profilu rozmówcy.</p>{roomSettingsSaved && <p className="success-banner" role="status">{roomSettingsSaved}</p>}<button className="primary-button" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz ustawienia rozmowy'}</button></form>
        <section className="danger-zone"><h3>Usuń rozmowę prywatną</h3><p>Rozmowa zniknie z Twojego konta. Druga osoba zachowa swoją kopię.</p><button type="button" disabled={busy} onClick={() => void deleteConversation()}>Usuń rozmowę</button></section>
      </>}
    </section></div>}
    {contactsDialog && <div className="modal-layer" role="presentation"><section className="modal contacts-modal" role="dialog" aria-modal="true" aria-labelledby="server-contacts-title">
      <button className="icon-button modal-close" onClick={() => { setContactsDialog(false); resetServerContactForm() }} aria-label="Zamknij"><Icon name="close"/></button>
      <span className="modal-icon"><Icon name="contacts"/></span><h2 id="server-contacts-title">Kontakty</h2><p>Nazwy i avatary kontaktów są zapisane tylko w tej przeglądarce. Rozmowę rozpoczynasz po numerze telefonu.</p>
      <div className="contacts-list">{contacts.length === 0 && <p className="empty-dialog-note">Nie masz jeszcze zapisanych kontaktów.</p>}{contacts.map(contact => <article key={contact.id}><DemoAvatar name={contact.name} avatar={contact.avatar}/><div><strong>{contact.name}</strong><small>{contact.phone}</small></div><span><button type="button" disabled={busy} onClick={() => openServerContactConversation(contact)}>Napisz</button><button type="button" onClick={() => editServerContact(contact)}>Edytuj</button><button className="danger-link" type="button" onClick={() => removeServerContact(contact)}>Usuń</button></span></article>)}</div>
      <form className="contact-form" onSubmit={saveServerContact}><h3>{editingContactId ? 'Edytuj kontakt' : 'Dodaj kontakt'}</h3><div className="avatar-editor"><DemoAvatar name={contactName || 'Nowy kontakt'} avatar={contactAvatar}/><label className="secondary-button">Wybierz avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectServerContactAvatar(file); event.target.value = '' }}/></label>{contactAvatar && <button type="button" className="text-button" onClick={() => setContactAvatar('')}>Usuń zdjęcie</button>}</div><label>Imię lub nazwa<input required maxLength={60} value={contactName} onChange={event => setContactName(event.target.value)} placeholder="np. Jan Nowak"/></label><label>Numer telefonu<input required type="tel" inputMode="tel" value={contactPhone} onChange={event => setContactPhone(event.target.value)} placeholder="+48 500 000 000"/></label><button className="primary-button">{editingContactId ? 'Zapisz zmiany' : 'Dodaj kontakt'}</button>{editingContactId && <button className="secondary-button" type="button" onClick={resetServerContactForm}>Anuluj edycję</button>}</form>
    </section></div>}
    {accountDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="server-account-title">
      <button className="icon-button modal-close" onClick={() => { setAccountDialog(false); setProfileAvatarFile(null) }} aria-label="Zamknij"><Icon name="close"/></button>
      <span className="modal-icon"><Icon name="settings"/></span><h2 id="server-account-title">Ustawienia konta</h2><p>Nazwa i avatar są widoczne dla rozmówców. Opis i wybrany motyw pozostają w tej przeglądarce.</p>
      <form onSubmit={saveServerAccountSettings}><div className="avatar-editor"><ServerAvatar name={accountDraft.name || 'Użytkownik'} source={accountDraft.avatar} client={client}/><label className="secondary-button">Zmień avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectServerProfileAvatar(file); event.target.value = '' }}/></label>{accountDraft.avatar && <button type="button" className="text-button" onClick={() => { setProfileAvatarFile(null); setAccountDraft(current => ({ ...current, avatar: undefined })) }}>Usuń zdjęcie</button>}</div><label>Nazwa wyświetlana<input required maxLength={60} value={accountDraft.name} onChange={event => setAccountDraft(current => ({ ...current, name: event.target.value }))}/></label><label>Opis profilu<input maxLength={100} value={accountDraft.about} onChange={event => setAccountDraft(current => ({ ...current, about: event.target.value }))} placeholder="np. Dostępny"/></label><label>Motyw wiadomości<select value={theme} onChange={event => setTheme(event.target.value as ChatTheme)}><option value="system">Jak w urządzeniu</option><option value="light">Jasny kremowy</option><option value="dark">Ciemny bursztynowy</option><option value="blue">Złoto-pomarańczowy</option></select></label><section className="push-settings"><div><strong>Powiadomienia na tym urządzeniu</strong><small>{pushKey && pushPermission() === 'granted' ? 'Włączone — telefon poinformuje Cię o nowej wiadomości.' : pushNotificationsSupported() ? 'Włącz je osobno na każdym telefonie lub komputerze.' : 'Na iPhonie najpierw dodaj aplikację do ekranu początkowego.'}</small></div><button type="button" className={pushKey ? 'secondary-button' : 'primary-button'} disabled={pushBusy} onClick={() => void togglePushNotifications()}>{pushBusy ? 'Proszę czekać…' : pushKey ? 'Wyłącz powiadomienia' : 'Włącz powiadomienia'}</button>{pushNotice && <p className={pushKey ? 'success-banner' : 'push-notice'} role="status">{pushNotice}</p>}</section><p className="local-storage-note"><Icon name="lock"/> Powiadomienie nie pokazuje treści rozmowy. PIN nie jest tu wyświetlany ani zapisywany.</p><button className="primary-button" disabled={busy}>{busy ? 'Zapisywanie…' : 'Zapisz ustawienia'}</button></form>
    </section></div>}
    {historyDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="server-history-title"><button className="icon-button modal-close" onClick={() => setHistoryDialog(false)} aria-label="Zamknij"><Icon name="close"/></button><span className="modal-icon"><Icon name="history"/></span><h2 id="server-history-title">Historia rozmów</h2><p>Rozmowy są synchronizowane z Twoim prywatnym serwerem.</p><div className="dialog-room-list">{allJoinedRooms.length === 0 && <p className="empty-dialog-note">Historia jest jeszcze pusta.</p>}{allJoinedRooms.map(room => { const contact = contactForRoom(room); return <button type="button" key={room.roomId} onClick={() => { setActiveRoomId(room.roomId); setHistoryDialog(false) }}>{contact ? <DemoAvatar name={contact.name} avatar={contact.avatar}/> : <RoomAvatar room={room} client={client}/>}<span><strong>{displayRoomName(room)}</strong><small>{lastMessage(room)}</small></span><time>{roomTimestamp(room) ? formatTime(roomTimestamp(room)) : ''}</time></button> })}</div></section></div>}
    {filesDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="server-files-title"><button className="icon-button modal-close" onClick={() => setFilesDialog(false)} aria-label="Zamknij"><Icon name="close"/></button><span className="modal-icon"><Icon name="files"/></span><h2 id="server-files-title">Pliki i media</h2><p>Lista załączników z aktualnie zsynchronizowanych rozmów.</p><div className="dialog-file-list">{mediaItems.length === 0 && <p className="empty-dialog-note">Nie ma jeszcze żadnych załączników.</p>}{mediaItems.map(({ room, event, name }) => <button type="button" key={event.getId() ?? `${room.roomId}-${event.getTs()}`} onClick={() => { setActiveRoomId(room.roomId); setFilesDialog(false) }}><span className="file-list-icon"><Icon name="files"/></span><span><strong>{name}</strong><small>{displayRoomName(room)}</small></span><time>{formatTime(event.getTs())}</time></button>)}</div></section></div>}
  </main>
}

function RoomAvatar({ room, client }: { room: Room, client?: MatrixClient | null }) {
  return <ServerAvatar name={safeRoomName(room)} source={room.getMxcAvatarUrl() ?? undefined} client={client}/>
}

function groupMemberDisplayName(member: RoomMember, contacts: ServerContact[], myUserId: string) {
  if (member.userId === myUserId) return 'Ty'
  const memberPhone = phoneFromUserId(member.userId).replace(/\D/g, '')
  const contact = memberPhone ? contacts.find(item => item.phone.replace(/\D/g, '') === memberPhone) : undefined
  if (contact) return contact.name
  const profileName = member.rawDisplayName?.trim() || member.name?.trim()
  return profileName && !profileName.startsWith('@') && !/^phone_\d+/.test(profileName) ? profileName : 'Uczestnik grupy'
}

function GroupMemberRow({ member, client, contacts, myUserId }: { member: RoomMember, client: MatrixClient, contacts: ServerContact[], myUserId: string }) {
  const name = groupMemberDisplayName(member, contacts, myUserId)
  return <article><ServerAvatar name={name} source={member.getMxcAvatarUrl() ?? undefined} client={client} size={80}/><div><strong>{name}</strong><small>{member.powerLevel >= 100 ? 'Administrator' : member.membership === 'invite' ? 'Oczekuje na dołączenie' : 'Członek grupy'}</small></div></article>
}

function isDirectRoom(client: MatrixClient | null, roomId: string) {
  if (!client) return false
  const directRooms = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {}
  return Object.values(directRooms).some(roomIds => roomIds.includes(roomId))
}

function lastMessage(room: Room) {
  const event = room.getLiveTimeline().getEvents().filter(item => item.getType() === EventType.RoomMessage).at(-1)
  return readableMessageBody(event?.getContent<{ body?: string }>().body) || 'Brak wiadomości'
}

function readableMessageBody(body?: string) {
  if (!body) return ''
  if (body.includes('Unable to decrypt') || body.includes('DecryptionError')) return 'Nie można odczytać tej starszej wiadomości na tym urządzeniu.'
  return body
}

function safeRoomName(room: Room) {
  return room.name && !room.name.startsWith('@') && !room.name.startsWith('!') && !/^phone_\d+$/.test(room.name) ? room.name : 'Prywatna rozmowa'
}

function Message({ event, room, client, own }: { event: MatrixEvent, room: Room, client: MatrixClient, own: boolean }) {
  const content = event.getContent<MatrixMediaContent>()
  const body = readableMessageBody(content.body)
  if (!body) return null
  const memberName = event.getSender() ? room.getMember(event.getSender()!)?.name : undefined
  const senderName = memberName && !memberName.startsWith('@') && !/^phone_\d+$/.test(memberName) ? memberName : 'Uczestnik'
  const hasMedia = ['m.image', 'm.video', 'm.audio', 'm.file'].includes(content.msgtype ?? '')
  const hasCaption = hasMedia && content.filename && body !== content.filename
  return <article className={`message ${own ? 'own' : ''} ${hasMedia ? 'with-media' : ''}`}><strong>{own ? 'Ty' : senderName}</strong>{hasMedia ? <MatrixMedia content={content} client={client} /> : <p>{body}</p>}{hasCaption && <p>{body}</p>}<time>{formatTime(event.getTs())}</time></article>
}

type DemoMessage = { id: number, author: string, body: string, time: string, own?: boolean, attachment?: File }
type DemoContact = { id: string, name: string, phone: string, avatar?: string }
type DemoProfile = { name: string, about: string, avatar?: string, notifications: boolean, messagePreviews: boolean }
type DemoConversation = {
  id: string
  name: string
  preview: string
  time: string
  messages: DemoMessage[]
  avatar?: string
  contactId?: string
  isGroup?: boolean
  members?: number
}
type DemoSnapshot = { version: 1, profile: DemoProfile, contacts: DemoContact[], conversations: DemoConversation[] }

const initialDemoProfile: DemoProfile = {
  name: 'Tadeusz',
  about: 'Dostępny',
  notifications: true,
  messagePreviews: true,
}

const initialDemoContacts: DemoContact[] = [
  { id: 'contact-anna', name: 'Anna Kowalska', phone: '+48 500 100 200' },
  { id: 'contact-marek', name: 'Marek Nowak', phone: '+48 500 200 300' },
  { id: 'contact-joanna', name: 'Joanna Wiśniewska', phone: '+48 500 300 400' },
]

const initialDemoConversations: DemoConversation[] = [
  {
    id: 'anna', contactId: 'contact-anna', name: 'Anna Kowalska', preview: 'Jasne, wszystko działa 👍', time: '21:42',
    messages: [
      { id: 1, author: 'Anna', body: 'Cześć! Widzę, że testujemy nowy komunikator.', time: '21:39' },
      { id: 2, author: 'Ty', body: 'Dokładnie. Jak wygląda rozmowa na Twoim telefonie?', time: '21:41', own: true },
      { id: 3, author: 'Anna', body: 'Jasne, wszystko działa 👍', time: '21:42' },
    ],
  },
  {
    id: 'team', name: 'Zespół projektu', preview: 'Marek: Do zobaczenia jutro', time: '18:16', isGroup: true, members: 5,
    messages: [
      { id: 4, author: 'Joanna', body: 'Pierwszy podgląd aplikacji jest gotowy.', time: '18:10' },
      { id: 5, author: 'Marek', body: 'Do zobaczenia jutro', time: '18:16' },
    ],
  },
  {
    id: 'technical', name: 'Test techniczny', preview: 'Połączenie z serwerem będzie kolejnym krokiem', time: 'wczoraj',
    messages: [
      { id: 6, author: 'System testowy', body: 'To wyłącznie lokalna rozmowa demonstracyjna. Nie łączy się z kontami na innych urządzeniach.', time: '12:00' },
    ],
  },
]

function DemoWorkspace({ phone, onLogout }: { phone: string, onLogout: () => void }) {
  const [conversations, setConversations] = useState(initialDemoConversations)
  const [contacts, setContacts] = useState(initialDemoContacts)
  const [profile, setProfile] = useState<DemoProfile>(initialDemoProfile)
  const [hydrated, setHydrated] = useState(false)
  const [activeId, setActiveId] = useState('')
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [attachmentPreview, setAttachmentPreview] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [newChat, setNewChat] = useState(false)
  const [groupDialog, setGroupDialog] = useState<'create' | 'join' | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupInvitation, setGroupInvitation] = useState('')
  const [groupMembers, setGroupMembers] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [contactAvatar, setContactAvatar] = useState('')
  const [editingContactId, setEditingContactId] = useState('')
  const [contactsDialog, setContactsDialog] = useState(false)
  const [accountDialog, setAccountDialog] = useState(false)
  const [accountDraft, setAccountDraft] = useState<DemoProfile>(initialDemoProfile)
  const [conversationDialog, setConversationDialog] = useState(false)
  const [conversationName, setConversationName] = useState('')
  const [conversationAvatar, setConversationAvatar] = useState('')
  const [notice, setNotice] = useState('')
  const active = conversations.find(conversation => conversation.id === activeId)
  const visible = conversations.filter(conversation => conversation.name.toLowerCase().includes(search.toLowerCase()))

  useEffect(() => () => {
    if (attachmentPreview) URL.revokeObjectURL(attachmentPreview)
  }, [attachmentPreview])

  useEffect(() => {
    let activeRequest = true
    readLocalAccount<DemoSnapshot>(phone).then(snapshot => {
      if (!activeRequest) return
      if (snapshot?.version === 1) {
        setProfile(snapshot.profile)
        setContacts(snapshot.contacts)
        setConversations(snapshot.conversations)
      }
    }).catch(() => {
      if (activeRequest) setNotice('Nie udało się odczytać danych zapisanych na tym urządzeniu.')
    }).finally(() => {
      if (activeRequest) setHydrated(true)
    })
    return () => { activeRequest = false }
  }, [phone])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => {
      const snapshot: DemoSnapshot = { version: 1, profile, contacts, conversations }
      saveLocalAccount(phone, snapshot).catch(() => setNotice('Brak miejsca na zapis danych na tym urządzeniu.'))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [contacts, conversations, hydrated, phone, profile])

  function sendDemoMessage(event: FormEvent) {
    event.preventDefault()
    const body = draft.trim()
    if (!active || (!body && !pendingFile)) return
    const time = new Intl.DateTimeFormat('pl', { hour: '2-digit', minute: '2-digit' }).format(Date.now())
    const messageBody = body || pendingFile?.name || ''
    setConversations(current => current.map(conversation => conversation.id === active.id ? {
      ...conversation,
      preview: pendingFile ? `📎 ${pendingFile.name}` : messageBody,
      time,
      messages: [...conversation.messages, { id: Date.now(), author: 'Ty', body: messageBody, time, own: true, attachment: pendingFile ?? undefined }],
    } : conversation))
    setDraft('')
    setPendingFile(null)
    setAttachmentPreview('')
  }

  function selectDemoAttachment(file: File) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setNotice('Załącznik może mieć maksymalnie 25 MB.')
      return
    }
    setNotice('')
    setPendingFile(file)
    setAttachmentPreview(file.type.startsWith('image/') || file.type.startsWith('video/') ? URL.createObjectURL(file) : '')
  }

  function clearDemoAttachment() {
    setPendingFile(null)
    setAttachmentPreview('')
  }

  function createDemoChat(event: FormEvent) {
    event.preventDefault()
    const name = contactName.trim()
    if (!name) return
    const existingContact = contacts.find(contact => contact.name.toLocaleLowerCase('pl') === name.toLocaleLowerCase('pl'))
    const contact = existingContact ?? { id: `contact-${Date.now()}`, name, phone: '' }
    if (!existingContact) setContacts(current => [contact, ...current])
    const existingConversation = conversations.find(conversation => conversation.contactId === contact.id)
    const id = existingConversation?.id ?? `demo-${Date.now()}`
    if (!existingConversation) setConversations(current => [{ id, contactId: contact.id, name, avatar: contact.avatar, preview: 'Nowa rozmowa', time: 'teraz', messages: [] }, ...current])
    setActiveId(id)
    setContactName('')
    setNewChat(false)
  }

  function resetContactForm() {
    setEditingContactId('')
    setContactName('')
    setContactPhone('')
    setContactAvatar('')
  }

  function editContact(contact: DemoContact) {
    setEditingContactId(contact.id)
    setContactName(contact.name)
    setContactPhone(contact.phone)
    setContactAvatar(contact.avatar ?? '')
  }

  async function selectAvatar(file: File, setter: (value: string) => void) {
    try { setter(await imageAsDataUrl(file)); setNotice('') }
    catch (reason) { setNotice(reason instanceof Error && reason.message === 'IMAGE_TOO_LARGE' ? 'Avatar może mieć maksymalnie 3 MB.' : 'Wybierz prawidłowy plik ze zdjęciem.') }
  }

  function saveContact(event: FormEvent) {
    event.preventDefault()
    const name = contactName.trim()
    const normalizedPhone = contactPhone.trim()
    if (!name) return
    const id = editingContactId || `contact-${Date.now()}`
    const contact: DemoContact = { id, name, phone: normalizedPhone, avatar: contactAvatar || undefined }
    setContacts(current => editingContactId ? current.map(item => item.id === id ? contact : item) : [contact, ...current])
    setConversations(current => current.map(conversation => conversation.contactId === id ? { ...conversation, name, avatar: contact.avatar } : conversation))
    resetContactForm()
    setNotice(editingContactId ? 'Kontakt został zaktualizowany.' : 'Kontakt został zapisany na tym urządzeniu.')
  }

  function openContactConversation(contact: DemoContact) {
    const existing = conversations.find(conversation => conversation.contactId === contact.id)
    const id = existing?.id ?? `demo-${Date.now()}`
    if (!existing) setConversations(current => [{ id, contactId: contact.id, name: contact.name, avatar: contact.avatar, preview: 'Nowa rozmowa', time: 'teraz', messages: [] }, ...current])
    setActiveId(id)
    setContactsDialog(false)
    setDrawer(false)
  }

  function removeContact(contact: DemoContact) {
    if (!window.confirm(`Usunąć kontakt „${contact.name}”? Rozmowa pozostanie na liście.`)) return
    setContacts(current => current.filter(item => item.id !== contact.id))
    setConversations(current => current.map(conversation => conversation.contactId === contact.id ? { ...conversation, contactId: undefined } : conversation))
    if (editingContactId === contact.id) resetContactForm()
  }

  function openAccountSettings() {
    setAccountDraft(profile)
    setAccountDialog(true)
    setDrawer(false)
  }

  function saveAccountSettings(event: FormEvent) {
    event.preventDefault()
    const name = accountDraft.name.trim()
    if (!name) return
    setProfile({ ...accountDraft, name, about: accountDraft.about.trim() || 'Dostępny' })
    setAccountDialog(false)
    setNotice('Ustawienia konta zostały zapisane na tym urządzeniu.')
  }

  function openConversationSettings() {
    if (!active) return
    setConversationName(active.name)
    setConversationAvatar(active.avatar ?? '')
    setConversationDialog(true)
  }

  function saveConversationSettings(event: FormEvent) {
    event.preventDefault()
    if (!active || !conversationName.trim()) return
    const nextName = conversationName.trim()
    setConversations(current => current.map(conversation => conversation.id === active.id ? { ...conversation, name: nextName, avatar: conversationAvatar || undefined } : conversation))
    if (active.contactId) setContacts(current => current.map(contact => contact.id === active.contactId ? { ...contact, name: nextName, avatar: conversationAvatar || undefined } : contact))
    setConversationDialog(false)
    setNotice(active.isGroup ? 'Nazwa i avatar grupy zostały zmienione.' : 'Nazwa i avatar rozmowy zostały zmienione.')
  }

  function deleteDemoConversation() {
    if (!active) return
    const warning = active.isGroup
      ? `Usunąć grupę „${active.name}” z tego urządzenia?`
      : `Usunąć rozmowę „${active.name}” z tego urządzenia?`
    if (!window.confirm(warning)) return
    setConversations(current => current.filter(conversation => conversation.id !== active.id))
    setActiveId('')
    setConversationDialog(false)
    setNotice(active.isGroup ? 'Grupa została usunięta z tego urządzenia.' : 'Rozmowa została usunięta z tego urządzenia.')
  }

  function submitDemoGroup(event: FormEvent) {
    event.preventDefault()
    if (groupDialog === 'create') {
      const name = groupName.trim()
      if (name.length < 3) return
      const memberCount = groupMembers.split(',').map(member => member.trim()).filter(Boolean).length + 1
      const id = `group-${Date.now()}`
      const group: DemoConversation = {
        id, name, isGroup: true, members: memberCount, preview: 'Grupa została utworzona', time: 'teraz',
        messages: [{ id: Date.now(), author: 'Komunikatr E-Prom', body: `Utworzono grupę „${name}”. Możesz już rozpocząć rozmowę.`, time: 'teraz' }],
      }
      setConversations(current => [group, ...current])
      setActiveId(id)
      setGroupName(''); setGroupMembers(''); setGroupDialog(null); setNotice('Grupa została utworzona.')
      return
    }

    const existing = conversations.find(conversation => conversation.id === 'eprom-test-group')
    if (!existing) {
      const joined: DemoConversation = {
        id: 'eprom-test-group', name: 'Grupa testowa E-Prom', isGroup: true, members: 8, preview: 'Dołączono do grupy', time: 'teraz',
        messages: [{ id: Date.now(), author: 'Komunikatr E-Prom', body: 'Dołączyłeś do grupy przy użyciu kodu zaproszenia.', time: 'teraz' }],
      }
      setConversations(current => [joined, ...current])
    }
    setActiveId('eprom-test-group')
    setGroupInvitation(''); setGroupDialog(null); setNotice('Dołączono do grupy testowej.')
  }

  function showPlannedFeature(label: string) {
    setNotice(`${label} zostaną rozszerzone po podłączeniu prywatnego serwera.`)
    setDrawer(false)
  }

  return <main className="workspace demo-workspace">
    {drawer && <button className="drawer-scrim" aria-label="Zamknij menu" onClick={() => setDrawer(false)} />}
    <aside className={`sidebar ${drawer ? 'open' : ''}`}>
      <header className="sidebar-brand">
        <span className="brand-mark small"><BrandIcon /></span><strong>Komunikatr E-Prom</strong>
        <span className="demo-badge">DEMO</span>
        <button className="icon-button close-drawer" onClick={() => setDrawer(false)} aria-label="Zamknij menu"><Icon name="close" /></button>
      </header>
      <button className="user-card user-card-button" onClick={openAccountSettings}>{profile.avatar ? <img className="user-avatar" src={profile.avatar} alt="" /> : <span className="user-avatar">{profile.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span>}<div><strong>{profile.name}</strong><small>{profile.about} · {phone}</small></div></button>
      <nav className="side-nav" aria-label="Zasoby użytkownika">
        <button className="active" onClick={() => setDrawer(false)}><Icon name="chat" /><span>Wszystkie rozmowy</span><b>{conversations.length}</b></button>
        <button onClick={() => { setContactsDialog(true); setDrawer(false) }}><Icon name="contacts" /><span>Kontakty</span><b>{contacts.length}</b></button>
        <button onClick={() => showPlannedFeature('Pliki i media')}><Icon name="files" /><span>Pliki i media</span></button>
        <button onClick={() => showPlannedFeature('Historia')}><Icon name="history" /><span>Historia</span></button>
        <button onClick={openAccountSettings}><Icon name="settings" /><span>Ustawienia konta</span></button>
      </nav>
      <div className="sidebar-bottom">
        <p><span className="status-dot ready" /><strong>Tryb demonstracyjny</strong><small>Dane wyłącznie na tym urządzeniu</small></p>
        <button className="logout-button" onClick={onLogout}><Icon name="logout" />Wyloguj się</button>
      </div>
    </aside>

    <section className="rooms-panel">
      <header className="rooms-header">
        <button className="mobile-logo" onClick={() => setDrawer(true)} aria-label="Otwórz menu"><BrandIcon /></button>
        <div><span>Wersja demonstracyjna</span><h1>Wiadomości</h1></div>
        <button className="new-chat-button" onClick={() => setNewChat(true)} aria-label="Nowa rozmowa"><Icon name="plus" /></button>
      </header>
      <label className="search"><Icon name="search" /><span className="sr-only">Szukaj rozmów</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Szukaj rozmowy" /></label>
      <div className="group-actions"><button onClick={() => setGroupDialog('create')}><Icon name="contacts" />Utwórz grupę</button><button onClick={() => setGroupDialog('join')}><Icon name="plus" />Dołącz do grupy</button></div>
      {notice && <p className="demo-notice">{notice}<button onClick={() => setNotice('')} aria-label="Zamknij"><Icon name="close" /></button></p>}
      <div className="rooms-scroll">
        <h2 className="list-title">Rozmowy <span>{visible.length}</span></h2>
        <div className="room-list">{visible.map(conversation => <button key={conversation.id} className={conversation.id === activeId ? 'active' : ''} onClick={() => setActiveId(conversation.id)}><DemoAvatar name={conversation.name} avatar={conversation.avatar} /><span><strong>{conversation.name}</strong><small>{conversation.preview}</small></span><time>{conversation.time}</time></button>)}</div>
      </div>
    </section>

    <section className={`chat-panel ${active ? 'mobile-active' : ''}`}>
      {active ? <>
        <header className="chat-header"><button className="back-button" onClick={() => setActiveId('')} aria-label="Wróć do rozmów">‹</button><DemoAvatar name={active.name} avatar={active.avatar} /><div><strong>{active.name}</strong><small><Icon name="lock" /> {active.isGroup ? `${active.members ?? 1} uczestników · grupa chroniona` : 'Podgląd chronionej rozmowy'}</small></div><button className="chat-settings-button" type="button" onClick={openConversationSettings} aria-label="Ustawienia rozmowy"><Icon name="settings" /></button></header>
        <div className="timeline">{active.messages.length === 0 && <div className="conversation-empty"><Icon name="lock" /><h2>Nowa rozmowa</h2><p>Napisz pierwszą wiadomość.</p></div>}{active.messages.map(message => <article className={`message ${message.own ? 'own' : ''}`} key={message.id}><strong>{message.own ? 'Ty' : message.author}</strong>{message.attachment && <DemoMedia file={message.attachment} />}{(!message.attachment || message.body !== message.attachment.name) && <p>{message.body}</p>}<time>{message.time}</time></article>)}</div>
        <form className="composer" onSubmit={sendDemoMessage}>
          {pendingFile && <AttachmentPreview file={pendingFile} previewUrl={attachmentPreview} progress={0} onClear={clearDemoAttachment} />}
          <div className="composer-row"><AttachmentMenu onSelect={selectDemoAttachment} /><label><span className="sr-only">Treść wiadomości lub podpis załącznika</span><textarea rows={1} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={pendingFile ? 'Dodaj podpis…' : 'Napisz wiadomość…'} /></label><button disabled={!draft.trim() && !pendingFile} aria-label="Wyślij wiadomość"><Icon name="send" /></button></div>
        </form>
      </> : <div className="chat-placeholder"><span><Icon name="chat" /></span><h2>Wybierz rozmowę</h2><p>Otwórz rozmowę z listy albo rozpocznij nową.</p><button onClick={() => setNewChat(true)}><Icon name="plus" />Nowa rozmowa</button></div>}
    </section>

    {newChat && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="demo-new-chat-title"><button className="icon-button modal-close" onClick={() => setNewChat(false)} aria-label="Zamknij"><Icon name="close" /></button><span className="modal-icon"><Icon name="chat" /></span><h2 id="demo-new-chat-title">Nowa rozmowa</h2><p>Wpisz nazwę osoby, aby zobaczyć działanie nowego czatu.</p><form onSubmit={createDemoChat}><label>Imię lub nazwa kontaktu<input autoFocus required value={contactName} onChange={event => setContactName(event.target.value)} placeholder="np. Jan Nowak" /></label><button className="primary-button">Rozpocznij rozmowę</button></form></section></div>}
    {groupDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="demo-group-title"><button className="icon-button modal-close" onClick={() => setGroupDialog(null)} aria-label="Zamknij"><Icon name="close" /></button><span className="modal-icon"><Icon name="contacts" /></span><h2 id="demo-group-title">{groupDialog === 'create' ? 'Utwórz nową grupę' : 'Dołącz do grupy'}</h2><p>{groupDialog === 'create' ? 'Nadaj grupie nazwę i wpisz osoby, które mają wziąć udział w teście.' : 'Wklej dowolny przykładowy kod. Tryb demonstracyjny utworzy tylko lokalny podgląd i nie połączy Cię z prawdziwą grupą.'}</p><form onSubmit={submitDemoGroup}>{groupDialog === 'create' ? <><label>Nazwa grupy<input autoFocus required minLength={3} maxLength={60} value={groupName} onChange={event => setGroupName(event.target.value)} placeholder="np. Zespół E-Prom" /></label><label>Uczestnicy<input value={groupMembers} onChange={event => setGroupMembers(event.target.value)} placeholder="Anna, Marek, Joanna" /></label></> : <label>Przykładowy kod<input autoFocus required value={groupInvitation} onChange={event => setGroupInvitation(event.target.value)} placeholder="np. DEMO-GRUPA" /></label>}<button className="primary-button">{groupDialog === 'create' ? 'Utwórz grupę' : 'Dołącz do grupy'}</button></form></section></div>}
    {contactsDialog && <div className="modal-layer" role="presentation"><section className="modal contacts-modal" role="dialog" aria-modal="true" aria-labelledby="contacts-title"><button className="icon-button modal-close" onClick={() => { setContactsDialog(false); resetContactForm() }} aria-label="Zamknij"><Icon name="close" /></button><span className="modal-icon"><Icon name="contacts" /></span><h2 id="contacts-title">Kontakty</h2><p>Kontakty są zapisane wyłącznie na tym urządzeniu i nie przechodzą przez Google.</p><div className="contacts-list">{contacts.map(contact => <article key={contact.id}><DemoAvatar name={contact.name} avatar={contact.avatar} /><div><strong>{contact.name}</strong><small>{contact.phone || 'Bez numeru telefonu'}</small></div><span><button type="button" onClick={() => openContactConversation(contact)}>Napisz</button><button type="button" onClick={() => editContact(contact)}>Edytuj</button><button className="danger-link" type="button" onClick={() => removeContact(contact)}>Usuń</button></span></article>)}</div><form className="contact-form" onSubmit={saveContact}><h3>{editingContactId ? 'Edytuj kontakt' : 'Dodaj kontakt'}</h3><div className="avatar-editor"><DemoAvatar name={contactName || 'Nowy kontakt'} avatar={contactAvatar} /><label className="secondary-button">Wybierz avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectAvatar(file, setContactAvatar); event.target.value = '' }} /></label>{contactAvatar && <button type="button" className="text-button" onClick={() => setContactAvatar('')}>Usuń zdjęcie</button>}</div><label>Imię i nazwisko<input required value={contactName} onChange={event => setContactName(event.target.value)} placeholder="np. Jan Nowak" /></label><label>Numer telefonu<input type="tel" inputMode="tel" value={contactPhone} onChange={event => setContactPhone(event.target.value)} placeholder="+48 500 000 000" /></label><button className="primary-button">{editingContactId ? 'Zapisz zmiany' : 'Dodaj kontakt'}</button>{editingContactId && <button className="secondary-button" type="button" onClick={resetContactForm}>Anuluj edycję</button>}</form></section></div>}
    {accountDialog && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="account-title"><button className="icon-button modal-close" onClick={() => setAccountDialog(false)} aria-label="Zamknij"><Icon name="close" /></button><span className="modal-icon"><Icon name="settings" /></span><h2 id="account-title">Ustawienia konta</h2><p>Dane profilu pozostają na tym urządzeniu do czasu podłączenia prywatnego serwera.</p><form onSubmit={saveAccountSettings}><div className="avatar-editor"><DemoAvatar name={accountDraft.name || 'Użytkownik'} avatar={accountDraft.avatar} /><label className="secondary-button">Zmień avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectAvatar(file, value => setAccountDraft(current => ({ ...current, avatar: value }))); event.target.value = '' }} /></label>{accountDraft.avatar && <button type="button" className="text-button" onClick={() => setAccountDraft(current => ({ ...current, avatar: undefined }))}>Usuń zdjęcie</button>}</div><label>Nazwa wyświetlana<input required maxLength={60} value={accountDraft.name} onChange={event => setAccountDraft(current => ({ ...current, name: event.target.value }))} /></label><label>Opis profilu<input maxLength={100} value={accountDraft.about} onChange={event => setAccountDraft(current => ({ ...current, about: event.target.value }))} placeholder="np. Dostępny" /></label><label className="setting-toggle"><span><strong>Powiadomienia</strong><small>Informuj o nowych wiadomościach</small></span><input type="checkbox" checked={accountDraft.notifications} onChange={event => setAccountDraft(current => ({ ...current, notifications: event.target.checked }))} /></label><label className="setting-toggle"><span><strong>Podgląd wiadomości</strong><small>Pokazuj treść w powiadomieniu</small></span><input type="checkbox" checked={accountDraft.messagePreviews} onChange={event => setAccountDraft(current => ({ ...current, messagePreviews: event.target.checked }))} /></label><p className="local-storage-note"><Icon name="lock" /> Motyw jasny lub ciemny jest dobierany automatycznie z ustawień telefonu.</p><button className="primary-button">Zapisz ustawienia</button></form></section></div>}
    {conversationDialog && active && <div className="modal-layer" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="conversation-settings-title"><button className="icon-button modal-close" onClick={() => setConversationDialog(false)} aria-label="Zamknij"><Icon name="close" /></button><span className="modal-icon"><Icon name="settings" /></span><h2 id="conversation-settings-title">{active.isGroup ? 'Ustawienia grupy' : 'Ustawienia kontaktu'}</h2><p>Zmień nazwę i zdjęcie widoczne w tej aplikacji.</p><form onSubmit={saveConversationSettings}><div className="avatar-editor"><DemoAvatar name={conversationName || active.name} avatar={conversationAvatar} /><label className="secondary-button">Zmień avatar<input type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void selectAvatar(file, setConversationAvatar); event.target.value = '' }} /></label>{conversationAvatar && <button type="button" className="text-button" onClick={() => setConversationAvatar('')}>Usuń zdjęcie</button>}</div><label>{active.isGroup ? 'Nazwa grupy' : 'Nazwa kontaktu'}<input required maxLength={60} value={conversationName} onChange={event => setConversationName(event.target.value)} /></label><button className="primary-button">Zapisz zmiany</button></form><section className="danger-zone"><h3>{active.isGroup ? 'Usuń grupę' : 'Usuń rozmowę'}</h3><p>Element zostanie usunięty wyłącznie z tego urządzenia demonstracyjnego.</p><button type="button" onClick={deleteDemoConversation}>{active.isGroup ? 'Usuń grupę' : 'Usuń rozmowę'}</button></section></section></div>}
  </main>
}

function DemoAvatar({ name, avatar }: { name: string, avatar?: string }) {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
  return avatar ? <img className="room-avatar" src={avatar} alt="" /> : <span className="room-avatar">{initials}</span>
}

function DemoMedia({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  if (file.type.startsWith('image/')) return <ExpandableImage src={url} name={file.name} />
  if (file.type.startsWith('video/')) return <video className="message-media" src={url} controls preload="metadata" />
  if (file.type.startsWith('audio/')) return <audio className="message-audio" src={url} controls preload="metadata" />
  return <a className="message-file" href={url} download={file.name}><span><Icon name="file" /></span><span><b>{file.name}</b><small>{formatFileSize(file.size)}</small></span></a>
}
