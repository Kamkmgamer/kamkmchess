import type { ReviewedMove } from './review.js';

const DATABASE = 'kamkmchess.recaps.v1';
const STORE = 'reviews';
const LIMIT = 12;
interface SavedReview { readonly key: string; readonly updatedAt: number; readonly moves: readonly ReviewedMove[] }

async function database(): Promise<IDBDatabase | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    return await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Review storage is unavailable.'));
    });
  } catch { return null; }
}

export async function loadReview(key: string): Promise<readonly ReviewedMove[]> {
  const db = await database();
  if (!db) return [];
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => {
        const saved: SavedReview | undefined = request.result;
        resolve(saved?.key === key && Array.isArray(saved.moves) ? saved.moves : []);
      };
      request.onerror = () => reject(request.error);
    });
  } catch { return []; } finally { db.close(); }
}

/** Optional local checkpoints. Quota denial must never prevent a review or export. */
export async function saveReview(key: string, moves: readonly ReviewedMove[]): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      store.put({ key, moves, updatedAt: Date.now() } satisfies SavedReview);
      const entries = store.getAll();
      entries.onsuccess = () => {
        const records: SavedReview[] = entries.result;
        for (const record of records.sort((a, b) => b.updatedAt - a.updatedAt).slice(LIMIT)) store.delete(record.key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { /* A review remains usable in memory. */ } finally { db.close(); }
}
