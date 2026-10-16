// Backup files: the app's data, photos included, as one .zip that opens as a folder in
// the Files app and can be saved, emailed or moved to another phone, then restored.
// Earlier versions made a .json file; those can still be restored.

import * as db from './db.js';
import { makeZip, readZip, isZip } from './zip.js';

const APP = 'wetcheck';
const FORMAT = 1;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Restored photos get their own bytes in memory. A Blob that only points into the picked
// backup file loses its contents on iPhone and iPad once Safari lets go of that file, which
// showed as photos turning into question marks after a report was edited.
async function ownBlob(blob, type = blob.type) {
  return new Blob([await blob.arrayBuffer()], { type });
}

async function dataUrlToBlob(url) {
  return ownBlob(await (await fetch(url)).blob());
}

// Photos and logos are Blobs, which JSON can't hold: store them as { $blob: "data:..." }.
async function encode(value) {
  if (value instanceof Blob) return { $blob: await blobToDataUrl(value) };
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await encode(v);
    return out;
  }
  return value;
}

async function decode(value) {
  if (value && typeof value === 'object' && typeof value.$blob === 'string') return dataUrlToBlob(value.$blob);
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await decode(v);
    return out;
  }
  return value;
}

const stamp = () => new Date().toISOString().slice(0, 10);
const safe = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
// Folder and file names: inch marks read better as "in" (6" pop-up -> 6in pop-up).
const fileSafe = (s) => safe(String(s).replace(/(\d)"/g, '$1in')).replace(/^\.+/, '') || 'Untitled';
const extOf = (blob) => (blob.type === 'image/png' ? 'png' : blob.type === 'application/pdf' ? 'pdf' : 'jpg');
const typeOf = (path) => (/\.png$/i.test(path) ? 'image/png' : /\.pdf$/i.test(path) ? 'application/pdf' : 'image/jpeg');
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

const ROOT = 'Wet Check/';
const DATA_FILE = 'App data/wetcheck-data.json';

/**
 * Makes a backup: a zip that opens as a "Wet Check" folder with Settings, a folder per
 * property (and its folders and subdivisions), each report's PDF and photos, and an
 * "App data" file that Restore reads.
 * folderId: back up one property (folder and everything in it); omit for everything.
 * makePdf(report) -> { blob, name }; progress(text) shows how far along it is.
 */
export async function createBackup(appVersion, folderId = null, { makePdf, progress = () => {}, issueList = null } = {}) {
  const folder = folderId ? await db.getFolder(folderId) : null;
  const data = folderId ? await db.dumpFolder(folderId) : await db.dumpAll();
  // lastBackupAt describes this device, so it doesn't travel with the backup.
  data.settings = data.settings.filter((s) => s.key !== 'lastBackupAt');

  const entries = [];
  const used = new Set();
  const paths = new Map(); // Blob -> path in the zip, so the data file can point at it
  const add = (path, blob) => {
    let p = path;
    for (let n = 2; used.has(p.toLowerCase()); n++) p = path.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    used.add(p.toLowerCase());
    entries.push({ path: ROOT + p, data: blob });
    if (blob instanceof Blob) paths.set(blob, ROOT + p);
    return p;
  };
  const addDir = (path) => {
    if (used.has(path.toLowerCase())) return;
    used.add(path.toLowerCase());
    entries.push({ path: ROOT + path });
  };

  // Settings
  const setting = (key) => (data.settings.find((s) => s.key === key) || {}).value;
  if (!folderId) {
    addDir('Settings/');
    const logo = setting('companyLogo');
    if (logo instanceof Blob) add(`Settings/Company logo.${extOf(logo)}`, logo);
    const sig = setting('signatureImage');
    if (sig instanceof Blob) add(`Settings/Signature.${extOf(sig)}`, sig);
    const lines = [
      `Company name: ${setting('companyName') || ''}`,
      `Report accent color: ${setting('accentColor') || 'default'}`,
      `Troubleshooting disclaimer: ${setting('disclaimer') || 'default'}`,
      `Technician signature: ${setting('signatureEnabled') ? 'on' : 'off'}${setting('signatureName') ? `, ${setting('signatureName')}` : ''}${setting('signatureRole') ? `, ${setting('signatureRole')}` : ''}`,
    ];
    add('Settings/Settings.txt', lines.join('\n') + '\n');
    if (issueList) {
      const rows = [['Group', 'Issue', 'Price', 'In use']];
      for (const g of issueList.groups) for (const i of g.issues) rows.push([g.name, i.name, i.price == null ? '' : i.price.toFixed(2), i.off ? 'No' : 'Yes']);
      add('Settings/Issues and prices.csv', rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
    }
  }

  // Folders, nested the same way as in the app.
  const byId = new Map(data.folders.map((f) => [f.id, f]));
  const dirOf = new Map();
  const folderDir = (f) => {
    if (dirOf.has(f.id)) return dirOf.get(f.id);
    const parent = byId.get(f.parentId);
    const d = (parent ? folderDir(parent) : '') + fileSafe(f.name) + '/';
    dirOf.set(f.id, d);
    return d;
  };
  for (const f of data.folders) {
    addDir(folderDir(f));
    if (f.photo instanceof Blob) add(`${folderDir(f)}Property photo.${extOf(f.photo)}`, f.photo);
    if (f.controllers && f.controllers.length) {
      add(`${folderDir(f)}Controllers.txt`, controllersText(f.controllers));
      f.controllers.forEach((c, i) => {
        if (c.photo instanceof Blob) add(`${folderDir(f)}Controller photos/${fileSafe(`${String(i + 1).padStart(2, '0')} ${c.name}`)}.${extOf(c.photo)}`, c.photo);
      });
    }
  }

  // Reports: <folder>/<controller or subdivision>/<date name>/ with the PDF and a Photos folder.
  const findingsBy = new Map();
  for (const f of data.findings) {
    if (!findingsBy.has(f.reportId)) findingsBy.set(f.reportId, []);
    findingsBy.get(f.reportId).push(f);
  }
  let pdfsFailed = 0;
  for (let r = 0; r < data.reports.length; r++) {
    const report = data.reports[r];
    const parent = byId.get(report.folderId);
    const base = (parent ? folderDir(parent) : '')
      + (report.controllerName || report.subdivision ? fileSafe(report.controllerName || report.subdivision) + '/' : '')
      + fileSafe(`${report.date} ${report.name}`) + '/';
    progress(`Report ${r + 1} of ${data.reports.length}: ${report.name}`);
    addDir(base);
    if (makePdf) {
      try {
        const pdf = await makePdf(report);
        add(base + fileSafe(pdf.name.replace(/\.pdf$/i, '')) + '.pdf', pdf.blob);
      } catch {
        pdfsFailed++;
      }
    }
    const findings = (findingsBy.get(report.id) || []).sort((a, b) => a.createdAt - b.createdAt);
    findings.forEach((f, i) => {
      const label = fileSafe(`${String(i + 1).padStart(2, '0')} ${f.zone ? `Zone ${f.zone}` : 'No zone'} - ${f.issue}`);
      if (f.photo instanceof Blob) add(`${base}Photos/${label}.${extOf(f.photo)}`, f.photo);
      (f.morePhotos || []).forEach((b, k) => {
        if (b instanceof Blob) add(`${base}Photos/${label} (photo ${k + 2}).${extOf(b)}`, b);
      });
    });
  }

  // The data Restore reads. Photos point at the files above instead of being copied in.
  progress('Finishing up…');
  const ref = async (value) => {
    if (value instanceof Blob) {
      if (!paths.has(value)) add(`App data/files/${paths.size + 1}.${extOf(value)}`, value);
      return { $file: paths.get(value) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(ref));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await ref(v);
      return out;
    }
    return value;
  };
  const file = {
    app: APP,
    format: FORMAT,
    kind: folderId ? 'property' : 'full',
    name: folder ? folder.name : null,
    exportedAt: Date.now(),
    appVersion,
    ...(await ref(data)),
  };
  add(DATA_FILE, JSON.stringify(file));
  add('App data/Read me.txt', 'This folder lets the Wet Check app restore everything in this backup.\nTo restore, choose the backup .zip file in Settings > Backup and restore.\nDon\'t change or move the files in this backup if you want to restore from it.\n');

  const blob = await makeZip(entries);
  const name = safe(`${folder ? folder.name : 'Wet Check'} backup ${stamp()}.zip`);
  if (!folderId) await db.setSetting('lastBackupAt', file.exportedAt);
  return { blob, name, counts: countsOf(data), pdfsFailed };
}

function countsOf(d) {
  return {
    folders: d.folders.length,
    reports: d.reports.length,
    findings: d.findings.length,
  };
}

const NOT_BACKUP = 'That file isn’t a Wet Check backup.';

// Reads a backup: a .zip from this version, or a .json from earlier versions.
// Resolves with { kind, name, exportedAt, counts, data } or throws a readable error.
export async function readBackup(file) {
  let parsed;
  let files = null;
  try {
    if (await isZip(file)) {
      files = await readZip(file);
      const key = [...files.keys()].find((k) => k.endsWith(DATA_FILE));
      if (!key) throw new Error(NOT_BACKUP);
      parsed = JSON.parse(await (await files.get(key)()).text());
    } else {
      parsed = JSON.parse(await file.text());
    }
  } catch {
    throw new Error(NOT_BACKUP);
  }
  if (!parsed || parsed.app !== APP) throw new Error(NOT_BACKUP);
  if (parsed.format > FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app, then try again.');

  // Zip backups point at photo files; a missing one comes back empty rather than failing.
  const prefix = files ? [...files.keys()].find((k) => k.endsWith(DATA_FILE)).slice(0, -(ROOT + DATA_FILE).length) : '';
  const resolve = async (value) => {
    if (value && typeof value === 'object' && typeof value.$file === 'string') {
      const get = files && files.get(prefix + value.$file);
      if (!get) return null;
      return ownBlob(await get(), typeOf(value.$file));
    }
    if (Array.isArray(value)) return (await Promise.all(value.map(resolve))).filter((v) => v !== null);
    if (value && typeof value === 'object' && !(value instanceof Blob)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await resolve(v);
      return out;
    }
    return value;
  };
  const data = await resolve(await decode({
    folders: parsed.folders || [],
    reports: parsed.reports || [],
    findings: parsed.findings || [],
    settings: parsed.settings || [],
  }));
  return { kind: parsed.kind, name: parsed.name, exportedAt: parsed.exportedAt, counts: countsOf(data), data };
}

export function restoreBackup(backup, { replace }) {
  return db.restore(backup.data, { replace });
}

// The property's controllers, readable without the app.
function controllersText(list) {
  const yn = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '');
  const water = { municipal: 'Municipal', pump: 'Pump fed' };
  return list.map((c) => [
    c.name,
    ['GPS location', c.location ? `${c.location.lat.toFixed(6)}, ${c.location.lon.toFixed(6)}` : ''],
    ['Make', c.make],
    ['Model', c.model],
    ['Zones', c.zones ? String(c.zones) : ''],
    ['Water source', water[c.water] || ''],
    ['Rain sensor', yn(c.rainSensor)],
    ['Master valve', yn(c.masterValve)],
    ['Point of connection', c.pocLocation ? `${c.pocLocation.lat.toFixed(6)}, ${c.pocLocation.lon.toFixed(6)}` : ''],
    ['Pump or backflow info', c.poc],
  ].map((x) => (Array.isArray(x) ? (x[1] ? `  ${x[0]}: ${x[1]}` : '') : x)).filter(Boolean).join('\n')).join('\n\n') + '\n';
}
