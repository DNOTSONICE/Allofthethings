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

// Photos are stored as plain bytes ({ $bytes, type }) rather than as Blobs. Safari keeps
// stored Blobs as separate files that it can lose: a photo written back after an edit, and
// photos restored from a backup on an iPad, turned into question marks. Bytes live inside
// the record itself, so they can't go missing. Records saved earlier still hold Blobs;
// they read the same way and switch to bytes the next time they're saved.
const plain = (v) => v && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);

async function pack(value) {
  if (value instanceof Blob) {
    try {
      return { $bytes: await value.arrayBuffer(), type: value.type };
    } catch {
      return value; // already unreadable: nothing left to copy
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map(pack));
  if (plain(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await pack(v);
    return out;
  }
  return value;
}

function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (plain(value)) {
    if (value.$bytes instanceof ArrayBuffer) return new Blob([value.$bytes], { type: value.type || '' });
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unpack(v);
    return out;
  }
  return value;
}

async function get(store, id) {
  const db = await openDb();
  return unpack(await promisify(db.transaction(store).objectStore(store).get(id)));
}

async function getAllBy(store, index, key) {
  const db = await openDb();
  return unpack(await promisify(db.transaction(store).objectStore(store).index(index).getAll(key)));
}

async function put(store, record) {
  const packed = await pack(record);
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(packed);
  await txDone(tx);
  return record;
}

// Rewrites records saved before photos were stored as bytes, one at a time so a large
// collection never sits in memory at once. Runs in the background once per device; a
// record changed meanwhile is left for its own save to convert.
export async function storePhotosAsBytes() {
  if (await getSetting('photosAsBytes')) return;
  const db = await openDb();
  for (const store of ['folders', 'reports', 'findings', 'settings']) {
    const keys = await promisify(db.transaction(store).objectStore(store).getAllKeys());
    for (const key of keys) {
      const raw = await promisify(db.transaction(store).objectStore(store).get(key));
      if (!hasBlob(raw)) continue;
      const packed = await pack(raw);
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      os.get(key).onsuccess = (e) => {
        const now = e.target.result;
        if (now && hasBlob(now) && (now.updatedAt || 0) === (raw.updatedAt || 0)) os.put(packed);
      };
      await txDone(tx);
    }
  }
  await setSetting('photosAsBytes', true);
}

function hasBlob(v) {
  if (v instanceof Blob) return true;
  if (Array.isArray(v)) return v.some(hasBlob);
  if (plain(v)) return Object.values(v).some(hasBlob);
  return false;
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
  return unpack(await promisify(db.transaction(store).objectStore(store).getAll()));
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

async function readable(b) {
  try {
    if (!b.size || !(await b.arrayBuffer()).byteLength) return false;
    if (b.type.startsWith('image/') && self.createImageBitmap) (await createImageBitmap(b)).close();
    return true;
  } catch {
    return false;
  }
}

// old with each unreadable photo swapped for the backup's copy, or null if none needed it.
async function repairBlobs(old, rec) {
  let changed = false;
  const fix = async (mine, theirs) => {
    if (mine instanceof Blob) {
      if (theirs instanceof Blob && !(await readable(mine))) {
        changed = true;
        return theirs;
      }
      return mine;
    }
    if (Array.isArray(mine) && Array.isArray(theirs)) {
      const out = [];
      for (let i = 0; i < mine.length; i++) {
        const x = mine[i];
        // Lists of records (a property's controllers) are matched by id, photo lists by position.
        const match = x && typeof x === 'object' && !(x instanceof Blob) && x.id ? theirs.find((t) => t && t.id === x.id) : theirs[i];
        out.push(await fix(x, match));
      }
      return out;
    }
    if (mine && typeof mine === 'object' && theirs && typeof theirs === 'object' && Object.values(mine).some((v) => v instanceof Blob)) {
      const out = { ...mine };
      for (const [k, v] of Object.entries(mine)) out[k] = await fix(v, theirs[k]);
      return out;
    }
    return mine;
  };
  const out = { ...old };
  for (const [k, v] of Object.entries(old)) out[k] = await fix(v, rec[k]);
  return changed ? out : null;
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

  // Work out every write first: checking photos needs awaits, which would end the transaction.
  const writes = [];
  const add = async (store, rec) => {
    const old = existing[store] && existing[store].get(rec.id);
    if (old && (old.updatedAt || 0) > (rec.updatedAt || 0)) {
      // Keep the newer copy on this device, but take the backup's photo wherever this
      // device's copy of it can no longer be read.
      const fixed = await repairBlobs(old, rec);
      if (fixed) writes.push([store, fixed]);
      return;
    }
    writes.push([store, rec]);
  };
  for (const f of folders) {
    // A property backup's top folder lands at the top level if its old parent isn't here.
    const parentId = f.parentId === ROOT || folderIds.has(f.parentId) ? f.parentId : ROOT;
    await add('folders', { ...f, parentId });
  }
  for (const r of reports) await add('reports', r);
  for (const f of findings) await add('findings', f);

  // When adding, this device's own logo, color and so on stay; the backup only fills gaps.
  for (const s of settings) if (replace || !existing.settingKeys.has(s.key)) writes.push(['settings', s]);
  for (const w of writes) w[1] = await pack(w[1]);

  const tx = db.transaction(stores, 'readwrite');
  if (replace) for (const s of stores) tx.objectStore(s).clear();
  for (const [store, rec] of writes) tx.objectStore(store).put(rec);
  const written = writes.filter(([store]) => store !== 'settings').length;
  await txDone(tx);
  return written;
}
