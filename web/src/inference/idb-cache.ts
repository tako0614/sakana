const DATABASE = 'evex-model-cache-v1';
const VERSION = 1;
const CHUNK_BYTES = 8 * 1024 * 1024;

interface CacheMeta {
  key: string;
  chunks: number;
  size: number;
  contentType: string;
  complete: boolean;
  updatedAt: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains('chunks')) {
        database.createObjectStore('chunks', { keyPath: ['key', 'index'] });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
  return databasePromise;
}

async function putChunk(key: string, index: number, data: ArrayBuffer): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction('chunks', 'readwrite');
  transaction.objectStore('chunks').put({ key, index, data });
  await transactionDone(transaction);
}

async function deleteChunks(key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction('chunks', 'readwrite');
  const store = transaction.objectStore('chunks');
  const range = IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
  const request = store.openKeyCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(transaction);
}

async function getMeta(key: string): Promise<CacheMeta | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction('meta', 'readonly');
  return requestResult(transaction.objectStore('meta').get(key)) as Promise<CacheMeta | undefined>;
}

async function getChunk(key: string, index: number): Promise<ArrayBuffer | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction('chunks', 'readonly');
  const row = (await requestResult(transaction.objectStore('chunks').get([key, index]))) as
    | { data: ArrayBuffer }
    | undefined;
  return row?.data;
}

export class IndexedDbModelCache {
  async match(request: string): Promise<Response | undefined> {
    const meta = await getMeta(String(request));
    if (!meta?.complete) return undefined;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= meta.chunks) {
          controller.close();
          return;
        }
        const chunk = await getChunk(meta.key, index);
        if (!chunk) {
          controller.error(new Error('IndexedDB cache chunk is missing'));
          return;
        }
        index += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    return new Response(stream, {
      headers: {
        'content-length': String(meta.size),
        'content-type': meta.contentType,
      },
    });
  }

  async put(
    request: string,
    response: Response,
    progressCallback?: (data: { progress: number; loaded: number; total: number }) => void,
  ): Promise<void> {
    const key = String(request);
    await this.delete(key);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Downloaded model has no readable body');
    const declaredTotal = Number(response.headers.get('content-length') ?? 0);
    let buffered = new Uint8Array(CHUNK_BYTES);
    let bufferedBytes = 0;
    let chunks = 0;
    let loaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        let offset = 0;
        while (offset < value.byteLength) {
          const taken = Math.min(CHUNK_BYTES - bufferedBytes, value.byteLength - offset);
          buffered.set(value.subarray(offset, offset + taken), bufferedBytes);
          bufferedBytes += taken;
          offset += taken;
          if (bufferedBytes === CHUNK_BYTES) {
            await putChunk(key, chunks, buffered.buffer);
            chunks += 1;
            buffered = new Uint8Array(CHUNK_BYTES);
            bufferedBytes = 0;
          }
        }
        progressCallback?.({
          loaded,
          total: declaredTotal || loaded,
          progress: declaredTotal ? (loaded / declaredTotal) * 100 : 0,
        });
      }
      if (bufferedBytes) {
        await putChunk(key, chunks, buffered.slice(0, bufferedBytes).buffer);
        chunks += 1;
      }
      const database = await openDatabase();
      const transaction = database.transaction('meta', 'readwrite');
      transaction.objectStore('meta').put({
        key,
        chunks,
        size: loaded,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        complete: true,
        updatedAt: Date.now(),
      } satisfies CacheMeta);
      await transactionDone(transaction);
    } catch (error) {
      await this.delete(key);
      throw error;
    }
  }

  async delete(request: string): Promise<boolean> {
    const key = String(request);
    const existed = Boolean(await getMeta(key));
    const database = await openDatabase();
    const transaction = database.transaction('meta', 'readwrite');
    transaction.objectStore('meta').delete(key);
    await transactionDone(transaction);
    await deleteChunks(key);
    return existed;
  }

  async clear(): Promise<void> {
    const database = await openDatabase();
    const transaction = database.transaction(['meta', 'chunks'], 'readwrite');
    transaction.objectStore('meta').clear();
    transaction.objectStore('chunks').clear();
    await transactionDone(transaction);
  }

  async size(): Promise<number> {
    const database = await openDatabase();
    const transaction = database.transaction('meta', 'readonly');
    const rows = (await requestResult(transaction.objectStore('meta').getAll())) as CacheMeta[];
    return rows.filter((row) => row.complete).reduce((sum, row) => sum + row.size, 0);
  }
}

export const modelCache = new IndexedDbModelCache();

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
