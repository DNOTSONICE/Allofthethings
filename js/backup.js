// Backup files: the app's data, photos included, as one JSON file that can be saved
// to Files, emailed or moved to another phone, then restored.

import * as db from './db.js';

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

async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
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

// folderId: back up one property (folder and everything in it); omit for everything.
export async function createBackup(appVersion, folderId = null) {
  const folder = folderId ? await db.getFolder(folderId) : null;
  const data = folderId ? await db.dumpFolder(folderId) : await db.dumpAll();
  // lastBackupAt describes this device, so it doesn't travel with the backup.
  data.settings = data.settings.filter((s) => s.key !== 'lastBackupAt');
  const file = {
    app: APP,
    format: FORMAT,
    kind: folderId ? 'property' : 'full',
    name: folder ? folder.name : null,
    exportedAt: Date.now(),
    appVersion,
    ...(await encode(data)),
  };
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const name = safe(`${folder ? folder.name : 'Wet Check'} backup ${stamp()}.json`);
  if (!folderId) await db.setSetting('lastBackupAt', file.exportedAt);
  return { blob, name, counts: countsOf(data) };
}

function countsOf(d) {
  return {
    folders: d.folders.length,
    reports: d.reports.length,
    findings: d.findings.length,
  };
}

// Reads a backup file. Resolves with { kind, name, exportedAt, counts, data } or throws a readable error.
export async function readBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('That file isn’t a Wet Check backup.');
  }
  if (!parsed || parsed.app !== APP) throw new Error('That file isn’t a Wet Check backup.');
  if (parsed.format > FORMAT) throw new Error('This backup was made by a newer version of the app. Update the app, then try again.');
  const data = await decode({
    folders: parsed.folders || [],
    reports: parsed.reports || [],
    findings: parsed.findings || [],
    settings: parsed.settings || [],
  });
  return { kind: parsed.kind, name: parsed.name, exportedAt: parsed.exportedAt, counts: countsOf(data), data };
}

export function restoreBackup(backup, { replace }) {
  return db.restore(backup.data, { replace });
}
