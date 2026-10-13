// Local storage for the app, backed by IndexedDB.
// Schema changes go in upgrade() with a bumped DB_VERSION so existing data is kept.

const DB_NAME = 'wetcheck';
const DB_VERSION = 1;

let dbPromise = null;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const folders = db.createObjectStore('folders', { keyPath: 'id' });
    folders.createIndex('parentId', 'parentId');
  }
  // Future: reports (indexed by folderId) and findings (indexed by reportId).
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Root-level folders use parentId "root" because IndexedDB can't index null.
export const ROOT = 'root';

export async function getFolder(id) {
  const db = await openDb();
  return promisify(db.transaction('folders').objectStore('folders').get(id));
}

export async function listChildren(parentId) {
  const db = await openDb();
  const store = db.transaction('folders').objectStore('folders');
  const items = await promisify(store.index('parentId').getAll(parentId));
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export async function createFolder(name, parentId) {
  const db = await openDb();
  const now = Date.now();
  const folder = { id: newId(), name, parentId, createdAt: now, updatedAt: now };
  const tx = db.transaction('folders', 'readwrite');
  tx.objectStore('folders').add(folder);
  await txDone(tx);
  return folder;
}

export async function renameFolder(id, name) {
  const db = await openDb();
  const tx = db.transaction('folders', 'readwrite');
  const store = tx.objectStore('folders');
  const folder = await promisify(store.get(id));
  folder.name = name;
  folder.updatedAt = Date.now();
  store.put(folder);
  await txDone(tx);
  return folder;
}

// Ids of every folder nested under id (not including id itself).
export async function listDescendantIds(id) {
  const out = [];
  const queue = [id];
  while (queue.length) {
    const kids = await listChildren(queue.shift());
    for (const k of kids) {
      out.push(k.id);
      queue.push(k.id);
    }
  }
  return out;
}

// Counts what a delete would remove, for the confirmation message.
export async function countContents(id) {
  const ids = await listDescendantIds(id);
  return { folders: ids.length };
}

export async function deleteFolder(id) {
  const ids = [id, ...(await listDescendantIds(id))];
  const db = await openDb();
  const tx = db.transaction('folders', 'readwrite');
  const store = tx.objectStore('folders');
  for (const fid of ids) store.delete(fid);
  await txDone(tx);
}

// Folder chain from the top level down to id, for breadcrumbs.
export async function getPath(id) {
  const path = [];
  let cur = id;
  while (cur && cur !== ROOT) {
    const f = await getFolder(cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}
