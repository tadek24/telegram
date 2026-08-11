export type TelegramArchiveMessage = {
  id: string
  author: string
  text: string
  timestamp: number
  own: boolean
  media?: { kind: 'photo' | 'video' | 'audio' | 'file', name: string }
}

export type TelegramArchiveChat = {
  id: string
  name: string
  kind: string
  importedAt: number
  messages: TelegramArchiveMessage[]
}

export type TelegramImportResult = {
  chats: TelegramArchiveChat[]
  messageCount: number
  skippedCount: number
}

type StoredTelegramArchive = {
  ownerId: string
  chats: TelegramArchiveChat[]
  updatedAt: number
}

const DATABASE_NAME = 'secure-communicator-archives'
const DATABASE_VERSION = 1
const ARCHIVE_STORE = 'telegram-archives'
const MAX_JSON_SIZE = 100 * 1024 * 1024

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ARCHIVE_STORE)) database.createObjectStore(ARCHIVE_STORE, { keyPath: 'ownerId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('ARCHIVE_DATABASE_OPEN_FAILED'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('ARCHIVE_DATABASE_TRANSACTION_FAILED'))
    transaction.onabort = () => reject(transaction.error ?? new Error('ARCHIVE_DATABASE_TRANSACTION_ABORTED'))
  })
}

export async function readTelegramArchive(ownerId: string): Promise<TelegramArchiveChat[]> {
  if (!ownerId || !('indexedDB' in window)) return []
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ARCHIVE_STORE, 'readonly')
    const request = transaction.objectStore(ARCHIVE_STORE).get(ownerId)
    const record = await new Promise<StoredTelegramArchive | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredTelegramArchive | undefined)
      request.onerror = () => reject(request.error ?? new Error('ARCHIVE_DATABASE_READ_FAILED'))
    })
    return Array.isArray(record?.chats) ? record.chats : []
  } finally {
    database.close()
  }
}

export async function saveTelegramArchive(ownerId: string, chats: TelegramArchiveChat[]) {
  if (!ownerId || !('indexedDB' in window)) throw new Error('ARCHIVE_DATABASE_UNAVAILABLE')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ARCHIVE_STORE, 'readwrite')
    transaction.objectStore(ARCHIVE_STORE).put({ ownerId, chats, updatedAt: Date.now() } satisfies StoredTelegramArchive)
    await transactionComplete(transaction)
  } finally {
    database.close()
  }
}

export function mergeTelegramArchives(current: TelegramArchiveChat[], incoming: TelegramArchiveChat[]) {
  const merged = new Map(current.map(chat => [chat.id, chat]))
  incoming.forEach(chat => merged.set(chat.id, chat))
  return [...merged.values()].sort((a, b) => {
    const newestA = a.messages.at(-1)?.timestamp ?? a.importedAt
    const newestB = b.messages.at(-1)?.timestamp ?? b.importedAt
    return newestB - newestA
  })
}

export async function importTelegramJson(file: File): Promise<TelegramImportResult> {
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error('TELEGRAM_JSON_REQUIRED')
  if (file.size <= 0) throw new Error('TELEGRAM_JSON_EMPTY')
  if (file.size > MAX_JSON_SIZE) throw new Error('TELEGRAM_JSON_TOO_LARGE')

    const worker = new Worker(new URL('./telegram-import.worker.ts', import.meta.url), { type: 'module' })
  const buffer = await file.arrayBuffer()
  return new Promise<TelegramImportResult>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate()
      reject(new Error('TELEGRAM_IMPORT_TIMEOUT'))
    }, 120_000)
    worker.onmessage = event => {
      window.clearTimeout(timeout)
      worker.terminate()
      const message = event.data as { ok?: boolean, result?: TelegramImportResult, error?: string }
      if (message.ok && message.result) resolve(message.result)
      else reject(new Error(message.error || 'TELEGRAM_IMPORT_FAILED'))
    }
    worker.onerror = () => {
      window.clearTimeout(timeout)
      worker.terminate()
      reject(new Error('TELEGRAM_IMPORT_FAILED'))
    }
    worker.postMessage(buffer, [buffer])
  })
}
