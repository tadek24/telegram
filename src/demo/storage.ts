const DATABASE_NAME = 'eprom-local-data'
const DATABASE_VERSION = 1
const ACCOUNT_STORE = 'accounts'

type StoredAccount<T> = {
  key: string
  value: T
  updatedAt: number
}

function accountKey(phone: string) {
  return phone.replace(/\D/g, '') || 'local-user'
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(ACCOUNT_STORE)) database.createObjectStore(ACCOUNT_STORE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('LOCAL_DATABASE_OPEN_FAILED'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('LOCAL_DATABASE_TRANSACTION_FAILED'))
    transaction.onabort = () => reject(transaction.error ?? new Error('LOCAL_DATABASE_TRANSACTION_ABORTED'))
  })
}

export async function readLocalAccount<T>(phone: string): Promise<T | null> {
  if (!('indexedDB' in window)) return null
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ACCOUNT_STORE, 'readonly')
    const request = transaction.objectStore(ACCOUNT_STORE).get(accountKey(phone))
    const record = await new Promise<StoredAccount<T> | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as StoredAccount<T> | undefined)
      request.onerror = () => reject(request.error ?? new Error('LOCAL_DATABASE_READ_FAILED'))
    })
    return record?.value ?? null
  } finally {
    database.close()
  }
}

export async function saveLocalAccount<T>(phone: string, value: T) {
  if (!('indexedDB' in window)) throw new Error('LOCAL_DATABASE_UNAVAILABLE')
  const database = await openDatabase()
  try {
    const transaction = database.transaction(ACCOUNT_STORE, 'readwrite')
    transaction.objectStore(ACCOUNT_STORE).put({ key: accountKey(phone), value, updatedAt: Date.now() } satisfies StoredAccount<T>)
    await transactionComplete(transaction)
  } finally {
    database.close()
  }
}
