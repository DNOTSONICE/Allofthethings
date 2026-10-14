// Local storage for the app, backed by IndexedDB.
// Schema changes go in upgrade() with a bumped DB_VERSION so existing data is kept.

const DB_NAME = 'wetcheck';
const DB_VERSION = 3;

let dbPromise = null;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const folders = db.createObjectStore('folders', { keyPath: 'id' });
    folders.createIndex('parentId', 'parentId');
  }
  if (oldVersion < 2) {
    const reports = db.createObjectStore('reports', { keyPath: 'id' });
    reports.createIndex('folderId', 'folderId');
    const findings = db.createObjectStore('findings', { keyPath: 'id' });
    findings.createIndex('reportId', 'reportId');
  }
  if (oldVersion < 3) {
    db.createObjectStore('settings', { keyPath: 'key' });
  }
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

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

async function get(store, id) {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).get(id));
}

async function getAllBy(store, index, key) {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).index(index).getAll(key));
}

// Safari can lose a photo when a Blob read from the database is written back into it
// (editing a finding saves its existing photo again): the new record points at the old
// photo's storage, which Safari then deletes. Copying each Blob's bytes into a fresh
// Blob first gives the new record its own copy.
async function freshBlob(b) {
  return new Blob([await b.arrayBuffer()], { type: b.type });
}

async function detachBlobs(record) {
  const out = { ...record };
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Blob) out[k] = await freshBlob(v);
    else if (Array.isArray(v) && v.some((x) => x instanceof Blob)) out[k] = await Promise.all(v.map((x) => (x instanceof Blob ? freshBlob(x) : x)));
  }
  return out;
}

async function put(store, record) {
  record = await detachBlobs(record);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record);
  await txDone(tx);
  return record;
}

// ---------- Folders ----------

// Root-level folders use parentId "root" because IndexedDB can't index null.
export const ROOT = 'root';

export const getFolder = (id) => get('folders', id);

export async function listChildren(parentId) {
  return (await getAllBy('folders', 'parentId', parentId)).sort(byName);
}

export async function createFolder(name, parentId) {
  const now = Date.now();
  return put('folders', { id: newId(), name, parentId, createdAt: now, updatedAt: now });
}

export async function renameFolder(id, name) {
  const folder = await getFolder(id);
  return put('folders', { ...folder, name, updatedAt: Date.now() });
}

// changes: e.g. { photo: Blob|null } for a property's cover photo.
export async function updateFolder(id, changes) {
  const folder = await getFolder(id);
  return put('folders', { ...folder, ...changes, updatedAt: Date.now() });
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

// Everything a folder delete would remove: nested folders, reports and their findings.
async function folderContents(id) {
  const folderIds = [id, ...(await listDescendantIds(id))];
  const reportIds = [];
  for (const fid of folderIds) {
    for (const r of await getAllBy('reports', 'folderId', fid)) reportIds.push(r.id);
  }
  const findingIds = [];
  for (const rid of reportIds) {
    for (const f of await getAllBy('findings', 'reportId', rid)) findingIds.push(f.id);
  }
  return { folderIds, reportIds, findingIds };
}

// Counts what a delete would remove, for the confirmation message.
export async function countContents(id) {
  const c = await folderContents(id);
  return { folders: c.folderIds.length - 1, reports: c.reportIds.length };
}

export async function deleteFolder(id) {
  const c = await folderContents(id);
  const db = await openDb();
  const tx = db.transaction(['folders', 'reports', 'findings'], 'readwrite');
  for (const x of c.folderIds) tx.objectStore('folders').delete(x);
  for (const x of c.reportIds) tx.objectStore('reports').delete(x);
  for (const x of c.findingIds) tx.objectStore('findings').delete(x);
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

// ---------- Reports ----------

export const getReport = (id) => get('reports', id);

// Newest wet check first.
export async function listReports(folderId) {
  const items = await getAllBy('reports', 'folderId', folderId);
  return items.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

export async function createReport(folderId, name, date, extra = {}) {
  const now = Date.now();
  return put('reports', { id: newId(), folderId, name, date, ...extra, createdAt: now, updatedAt: now });
}

export async function updateReport(id, changes) {
  const report = await getReport(id);
  return put('reports', { ...report, ...changes, updatedAt: Date.now() });
}

export async function deleteReport(id) {
  const findings = await getAllBy('findings', 'reportId', id);
  const db = await openDb();
  const tx = db.transaction(['reports', 'findings'], 'readwrite');
  tx.objectStore('reports').delete(id);
  for (const f of findings) tx.objectStore('findings').delete(f.id);
  await txDone(tx);
}

// ---------- Findings ----------

export const getFinding = (id) => get('findings', id);

// In the order they were added.
export async function listFindings(reportId) {
  const items = await getAllBy('findings', 'reportId', reportId);
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

// fields: { photo: Blob|null, issue, zone, note }
export async function saveFinding(reportId, fields, id = null) {
  const now = Date.now();
  const existing = id ? await getFinding(id) : null;
  return put('findings', {
    id: id || newId(),
    reportId,
    createdAt: existing ? existing.createdAt : now,
    ...fields,
    updatedAt: now,
  });
}

// When an issue is renamed in the issue list, findings saved with the old name follow it,
// as do property profiles and reports' saved prices.
export async function renameIssue(from, to) {
  const now = Date.now();
  const rekey = (obj) => {
    if (!obj || !(from in obj)) return null;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
    return out;
  };
  let n = 0;
  for (const f of await getAll('findings')) {
    if (f.issue !== from) continue;
    await put('findings', { ...f, issue: to, updatedAt: now }); // put() keeps the photo safe
    n++;
  }
  for (const r of await getAll('reports')) {
    const prices = rekey(r.prices);
    if (prices) await put('reports', { ...r, prices, updatedAt: now });
  }
  for (const folder of await getAll('folders')) {
    const issues = folder.profile && rekey(folder.profile.issues);
    if (issues) await put('folders', { ...folder, profile: { ...folder.profile, issues }, updatedAt: now });
  }
  return n;
}

export const getAllReports = () => getAll('reports');

export async function deleteFinding(id) {
  const db = await openDb();
  const tx = db.transaction('findings', 'readwrite');
  tx.objectStore('findings').delete(id);
  await txDone(tx);
}

// ---------- Settings ----------
// App-wide values such as the company logo: { key, value }.

export async function getSetting(key) {
  const row = await get('settings', key);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await put('settings', { key, value });
}

// ---------- Backup ----------

async function getAll(store) {
  const db = await openDb();
  return promisify(db.transaction(store).objectStore(store).getAll());
}

// Every record in the app, for a full backup.
export async function dumpAll() {
  const [folders, reports, findings, settings] = await Promise.all(
    ['folders', 'reports', 'findings', 'settings'].map(getAll)
  );
  return { folders, reports, findings, settings };
}

// One folder with everything inside it, for a property backup.
export async function dumpFolder(id) {
  const ids = [id, ...(await listDescendantIds(id))];
  const folders = (await Promise.all(ids.map(getFolder))).filter(Boolean);
  const reports = (await Promise.all(ids.map((f) => getAllBy('reports', 'folderId', f)))).flat();
  const findings = (await Promise.all(reports.map((r) => getAllBy('findings', 'reportId', r.id)))).flat();
  return { folders, reports, findings, settings: [] };
}

// Writes backup records in one transaction. With replace, everything already on the
// device is cleared first; otherwise records are added, and where the same item exists
// on both sides the more recently changed copy wins.
export async function restore({ folders = [], reports = [], findings = [], settings = [] }, { replace = false } = {}) {
  const db = await openDb();
  const stores = ['folders', 'reports', 'findings', 'settings'];
  const existing = {};
  if (!replace) {
    for (const s of ['folders', 'reports', 'findings']) {
      existing[s] = new Map((await getAll(s)).map((r) => [r.id, r]));
    }
    existing.settingKeys = new Set((await getAll('settings')).filter((r) => r.value != null && r.value !== '').map((r) => r.key));
  }
  const folderIds = new Set([...(existing.folders ? existing.folders.keys() : []), ...folders.map((f) => f.id)]);

  const tx = db.transaction(stores, 'readwrite');
  if (replace) for (const s of stores) tx.objectStore(s).clear();
  let written = 0;
  const write = (store, rec) => {
    const old = existing[store] && existing[store].get(rec.id);
    if (old && (old.updatedAt || 0) > (rec.updatedAt || 0)) return; // keep the newer copy on this device
    tx.objectStore(store).put(rec);
    written++;
  };
  for (const f of folders) {
    // A property backup's top folder lands at the top level if its old parent isn't here.
    const parentId = f.parentId === ROOT || folderIds.has(f.parentId) ? f.parentId : ROOT;
    write('folders', { ...f, parentId });
  }
  for (const r of reports) write('reports', r);
  for (const f of findings) write('findings', f);
  // When adding, this device's own logo, color and so on stay; the backup only fills gaps.
  for (const s of settings) if (replace || !existing.settingKeys.has(s.key)) tx.objectStore('settings').put(s);
  await txDone(tx);
  return written;
}
