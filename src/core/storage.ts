import type { StoredFile } from '../types';

const DATABASE_NAME = 'vision-os-beta';
const DATABASE_VERSION = 1;

export class LocalStorage {
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  async open(): Promise<void> {
    if (this.database) return;
    if (!('indexedDB' in globalThis)) throw new Error('IndexedDB is not available in this browser.');
    this.database = await this.openDatabase();
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('kv')) database.createObjectStore('kv');
        if (!database.objectStoreNames.contains('files')) database.createObjectStore('files', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
      request.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
    }).catch((error: unknown) => {
      this.opening = null;
      throw error;
    });
    return this.opening;
  }

  private async transaction<T>(store: 'kv' | 'files', mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    await this.open();
    const database = this.database;
    if (!database) throw new Error('Local storage is unavailable.');
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      let result!: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Local storage operation failed.'));
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was aborted.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
    });
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.transaction<T | undefined>('kv', 'readonly', (store) => store.get(key) as IDBRequest<T | undefined>);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.transaction<IDBValidKey>('kv', 'readwrite', (store) => store.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.transaction<undefined>('kv', 'readwrite', (store) => store.delete(key) as IDBRequest<undefined>);
  }

  async putFile(file: File, id = crypto.randomUUID()): Promise<StoredFile> {
    const record: StoredFile = {
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      createdAt: Date.now(),
      blob: file,
    };
    await this.transaction<IDBValidKey>('files', 'readwrite', (store) => store.put(record));
    return record;
  }

  async listFiles(): Promise<StoredFile[]> {
    const records = await this.transaction<StoredFile[]>('files', 'readonly', (store) => store.getAll() as IDBRequest<StoredFile[]>);
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  async list<T>(): Promise<Array<{ key: string; value: T }>> {
    await this.open();
    const database = this.database;
    if (!database) throw new Error('Local storage is unavailable.');
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('kv', 'readonly');
      const store = transaction.objectStore('kv');
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      transaction.oncomplete = () => resolve(keysRequest.result.map((key, index) => ({ key: String(key), value: valuesRequest.result[index] as T })));
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not list local records.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage listing was aborted.'));
    });
  }

  async getFile(id: string): Promise<StoredFile | undefined> {
    return this.transaction<StoredFile | undefined>('files', 'readonly', (store) => store.get(id) as IDBRequest<StoredFile | undefined>);
  }

  async deleteFile(id: string): Promise<void> {
    await this.transaction<undefined>('files', 'readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
  }

  async clearFiles(): Promise<void> {
    await this.transaction<undefined>('files', 'readwrite', (store) => store.clear() as IDBRequest<undefined>);
  }
}

export const storage = new LocalStorage();
