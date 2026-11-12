// Durable per-episode Blob staging in IndexedDB, independent of
// File System Access API and browser download dialogs. Media is stored locally;
// metadata never contains signed URLs, tokens or encryption keys.
const DB_NAME = 'hongguo-dl-queue-files';
const STORE = 'episodes';
let database;
function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function openDownloadStore() {
  if (database) return database;
  if (typeof indexedDB === 'undefined') throw new Error('此瀏覽器不支援 IndexedDB，無法暫存下載佇列');
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE))
      request.result.createObjectStore(STORE, { keyPath: 'id' });
  };
  database = await requestPromise(request);
  return database;
}
export async function storeDownload(jobId, filename, blob, media = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('不能保存空白下載檔案');
  const db = await openDownloadStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve({ id: jobId, filename, size: blob.size });
    tx.onerror = () => reject(tx.error || new Error('瀏覽器儲存空間不足'));
    tx.onabort = () => reject(tx.error || new Error('儲存空間不足，請移除佇列中的舊檔案'));
    tx.objectStore(STORE).put({ id: jobId, filename, blob,
      size: blob.size, codec: media.codec || null,
      width: media.width || null, height: media.height || null,
      seriesId: media.seriesId || null, created: Date.now() });
  });
}
export async function readDownload(jobId) {
  const db = await openDownloadStore();
  return requestPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(jobId));
}
export async function removeDownload(jobId) {
  const db = await openDownloadStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(jobId);
  });
}
export async function hasDownload(jobId) {
  const entry = await readDownload(jobId);
  return !!entry?.blob;
}
