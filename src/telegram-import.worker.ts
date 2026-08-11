import type { TelegramArchiveChat, TelegramArchiveMessage, TelegramImportResult } from './telegram-archive'

type UnknownRecord = Record<string, unknown>

const MAX_CHATS = 10_000
const MAX_MESSAGES = 500_000
const MAX_TEXT_LENGTH = 100_000
const MAX_NAME_LENGTH = 240

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function cleanText(value: unknown, limit = MAX_TEXT_LENGTH): string {
  if (typeof value === 'string') return value.replaceAll('\0', '').slice(0, limit)
  if (!Array.isArray(value)) return ''
  return value.map(part => {
    if (typeof part === 'string') return part
    const entity = record(part)
    return typeof entity?.text === 'string' ? entity.text : ''
  }).join('').replaceAll('\0', '').slice(0, limit)
}

function safeName(value: unknown, fallback: string) {
  const name = cleanText(value, MAX_NAME_LENGTH).trim()
  return name || fallback
}

function safeIdentifier(value: unknown, fallback: string) {
  const identifier = typeof value === 'string' || typeof value === 'number' ? String(value) : fallback
  return identifier.replace(/[^a-zA-Z0-9_.:@-]/g, '_').slice(0, 180) || fallback
}

function timestampOf(message: UnknownRecord) {
  const unix = typeof message.date_unixtime === 'string' || typeof message.date_unixtime === 'number'
    ? Number(message.date_unixtime) : Number.NaN
  if (Number.isFinite(unix) && unix > 0) return unix * 1_000
  const parsed = typeof message.date === 'string' ? Date.parse(message.date) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function fileLabel(path: unknown) {
  if (typeof path !== 'string') return ''
  return path.replaceAll('\\', '/').split('/').at(-1)?.replaceAll('\0', '').slice(0, 240) ?? ''
}

function mediaOf(message: UnknownRecord): TelegramArchiveMessage['media'] {
  const path = typeof message.photo === 'string' ? message.photo : typeof message.file === 'string' ? message.file : ''
  if (!path) return undefined
  const mime = typeof message.mime_type === 'string' ? message.mime_type.toLowerCase() : ''
  const extension = fileLabel(path).split('.').at(-1)?.toLowerCase() ?? ''
  const kind = typeof message.photo === 'string' || mime.startsWith('image/') ? 'photo'
    : mime.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(extension) ? 'video'
      : mime.startsWith('audio/') || ['mp3', 'm4a', 'ogg', 'wav'].includes(extension) ? 'audio' : 'file'
  return { kind, name: fileLabel(path) || 'Załącznik z Telegrama' }
}

function parseExport(value: unknown): TelegramImportResult {
  const root = record(value)
  const chatsNode = record(root?.chats)
  const chatList = Array.isArray(chatsNode?.list) ? chatsNode.list : Array.isArray(root?.chats) ? root.chats : null
  if (!chatList) throw new Error('TELEGRAM_JSON_INVALID')
  if (chatList.length > MAX_CHATS) throw new Error('TELEGRAM_EXPORT_TOO_MANY_CHATS')

  const personal = record(root?.personal_information)
  const personalId = personal && (typeof personal.user_id === 'string' || typeof personal.user_id === 'number') ? String(personal.user_id) : ''
  const personalName = [personal?.first_name, personal?.last_name].filter(part => typeof part === 'string').join(' ').trim()
  let totalMessages = 0
  let skippedCount = 0
  const importedAt = Date.now()
  const chats: TelegramArchiveChat[] = []

  for (let chatIndex = 0; chatIndex < chatList.length; chatIndex += 1) {
    const sourceChat = record(chatList[chatIndex])
    if (!sourceChat) { skippedCount += 1; continue }
    const sourceMessages = Array.isArray(sourceChat.messages) ? sourceChat.messages : []
    const chatId = safeIdentifier(sourceChat.id, `chat-${chatIndex}`)
    const messages: TelegramArchiveMessage[] = []

    for (let messageIndex = 0; messageIndex < sourceMessages.length; messageIndex += 1) {
      if (totalMessages >= MAX_MESSAGES) throw new Error('TELEGRAM_EXPORT_TOO_MANY_MESSAGES')
      const sourceMessage = record(sourceMessages[messageIndex])
      if (!sourceMessage) { skippedCount += 1; continue }
      const type = typeof sourceMessage.type === 'string' ? sourceMessage.type : 'message'
      if (type !== 'message' && type !== 'service') { skippedCount += 1; continue }
      const text = cleanText(sourceMessage.text)
      const media = mediaOf(sourceMessage)
      if (!text && !media) { skippedCount += 1; continue }
      const fromId = typeof sourceMessage.from_id === 'string' ? sourceMessage.from_id : ''
      const author = safeName(sourceMessage.from, type === 'service' ? 'Telegram' : 'Uczestnik')
      const sourceId = safeIdentifier(sourceMessage.id, String(messageIndex))
      messages.push({
        id: `${chatId}:${sourceId}`,
        author,
        text,
        timestamp: timestampOf(sourceMessage),
        own: Boolean(personalId && (fromId === personalId || fromId === `user${personalId}`)) || Boolean(personalName && author === personalName),
        media,
      })
      totalMessages += 1
    }

    if (messages.length === 0) continue
    messages.sort((a, b) => a.timestamp - b.timestamp)
    chats.push({
      id: chatId,
      name: safeName(sourceChat.name, 'Rozmowa z Telegrama'),
      kind: safeName(sourceChat.type, 'chat'),
      importedAt,
      messages,
    })
  }

  chats.sort((a, b) => (b.messages.at(-1)?.timestamp ?? 0) - (a.messages.at(-1)?.timestamp ?? 0))
  return { chats, messageCount: totalMessages, skippedCount }
}

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(event.data)
    const result = parseExport(JSON.parse(text) as unknown)
    self.postMessage({ ok: true, result })
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : 'TELEGRAM_IMPORT_FAILED'
    self.postMessage({ ok: false, error })
  }
}
