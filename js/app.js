import * as db from './db.js';
import { showDialog, askName, askAction, askConfirm, plural, formatDate, today } from './ui.js';
import { compressPhoto, compressLogo } from './photo.js';
import { loadIssues } from './issues.js';
import { buildReportPdf, pdfFileName } from './pdf.js';
import { getPosition, readExif, lookupCity, coordsText, mapUrl, stampDetails, copyText } from './location.js';

const $ = (sel) => document.querySelector(sel);

// Shown on the home screen so it's easy to tell which version a phone is running.
// Keep in step with VERSION in sw.js.
const APP_VERSION = 7;

// ---------- Error banner ----------
// Shows problems on screen instead of failing silently.

let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 8000);
}
window.addEventListener('error', (e) => showToast(`Something went wrong: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showToast(`Something went wrong: ${(r && r.message) || r}`);
});

const FOLDER_ICON = '<svg class="ico folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const REPORT_ICON = '<svg class="ico report" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 1.5V9h4.5M8 13h8M8 16.5h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

// ---------- Routing ----------
// #/            top-level folders
// #/f/<id>      a folder
// #/r/<id>      a report
// Using the URL hash means the phone's back button works.

function route() {
  const m = location.hash.match(/^#\/([fr])\/(.+)$/);
  if (!m) return { kind: 'folder', id: db.ROOT };
  return { kind: m[1] === 'r' ? 'report' : 'folder', id: decodeURIComponent(m[2]) };
}

const folderHref = (id) => (id === db.ROOT ? '#/' : `#/f/${encodeURIComponent(id)}`);
const reportHref = (id) => `#/r/${encodeURIComponent(id)}`;

let current = null; // what's on screen: { kind, id, record }
let lastScreen = '';

async function render() {
  const r = route();
  if (r.kind === 'report') await renderReport(r.id);
  else await renderFolder(r.id);
  // Start at the top when moving to a different screen, but not when refreshing the same one.
  const screen = `${r.kind}:${r.id}`;
  if (screen !== lastScreen) window.scrollTo(0, 0);
  lastScreen = screen;
}

function setHeader({ title, subtitle = '', crumbs = [], back = false, more = false }) {
  $('#title').textContent = title;
  $('#subtitle').textContent = subtitle;
  $('#subtitle').hidden = !subtitle;
  $('#back').hidden = !back;
  $('#header-more').hidden = !more;
  document.title = title === 'Properties' ? 'Wet Check' : `${title} · Wet Check`;
  const nav = $('#crumbs');
  nav.replaceChildren();
  nav.hidden = crumbs.length === 0;
  for (const c of crumbs) {
    const a = document.createElement('a');
    a.href = c.href;
    a.textContent = c.name;
    nav.append(a, document.createTextNode(' › '));
  }
}

function crumbsFor(path) {
  return [{ name: 'Properties', href: '#/' }, ...path.map((f) => ({ name: f.name, href: folderHref(f.id) }))];
}

// ---------- Folder screen ----------

async function renderFolder(id) {
  const path = id === db.ROOT ? [] : await db.getPath(id);
  if (id !== db.ROOT && path.length === 0) return (location.hash = '#/'); // folder no longer exists
  const here = path[path.length - 1] || null;
  current = { kind: 'folder', id, record: here };

  setHeader({
    title: here ? here.name : 'Properties',
    crumbs: path.length >= 2 ? crumbsFor(path.slice(0, -1)) : [],
    back: !!here,
  });
  $('#fab-label').textContent = 'New';

  const [folders, reports] = await Promise.all([db.listChildren(id), here ? db.listReports(id) : []]);
  $('#folder-list').replaceChildren(...folders.map(folderRow));
  $('#report-list').replaceChildren(...reports.map(reportRow));
  $('#reports-heading').hidden = reports.length === 0;
  $('#folder-empty').hidden = folders.length + reports.length > 0;
  $('#folder-empty').innerHTML = here
    ? 'Nothing here yet. Tap <strong>New</strong> to add a wet check report or a folder.'
    : 'No properties yet. Tap <strong>New</strong> to add a folder for one.';
  await renderCompanyCard(!here);
  renderPropertyPhoto(path.length === 1 ? here : null);
  $('#app-version').hidden = !!here;
  $('#app-version').textContent = `App version ${APP_VERSION}`;
  showView('folder');
}

// ---------- Company logo (home screen) ----------

let companyLogoUrl = null;

async function renderCompanyCard(show) {
  const card = $('#company-card');
  card.hidden = !show;
  if (!show) return;
  const [logo, name] = await Promise.all([db.getSetting('companyLogo'), db.getSetting('companyName')]);
  if (companyLogoUrl) URL.revokeObjectURL(companyLogoUrl);
  companyLogoUrl = logo ? URL.createObjectURL(logo) : null;
  const img = $('#company-card-img');
  img.hidden = !logo;
  if (logo) img.src = companyLogoUrl;
  else img.removeAttribute('src');
  $('#company-logo-box').classList.toggle('empty', !logo);
  $('#company-card-name').textContent = name || (logo ? 'Company logo' : 'Add your company logo');
}

async function editCompany() {
  let logo = await db.getSetting('companyLogo');
  $('#company-name').value = (await db.getSetting('companyName')) || '';
  const img = $('#logo-img');
  let url = null;
  const show = () => {
    if (url) URL.revokeObjectURL(url);
    url = logo ? URL.createObjectURL(logo) : null;
    img.hidden = !logo;
    if (logo) img.src = url;
    $('#logo-empty').hidden = !!logo;
    $('#logo-remove').hidden = !logo;
  };
  show();
  $('#logo-error').hidden = true;
  $('#logo-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      logo = await compressLogo(file);
      $('#logo-error').hidden = true;
      show();
    } catch {
      $('#logo-error').textContent = 'That image couldn’t be read. Try another one.';
      $('#logo-error').hidden = false;
    }
  };
  $('#logo-remove').onclick = () => {
    logo = null;
    show();
  };
  const result = await showDialog($('#company-dialog'));
  if (url) URL.revokeObjectURL(url);
  if (result !== 'ok') return;
  await db.setSetting('companyLogo', logo);
  await db.setSetting('companyName', $('#company-name').value.trim());
  render();
}

$('#company-card').addEventListener('click', editCompany);

// ---------- Property photo (top-level folders) ----------

let propertyPhotoUrl = null;

function renderPropertyPhoto(folder) {
  const box = $('#property-photo');
  box.hidden = !folder;
  if (!folder) return;
  if (propertyPhotoUrl) URL.revokeObjectURL(propertyPhotoUrl);
  propertyPhotoUrl = folder.photo ? URL.createObjectURL(folder.photo) : null;
  const img = $('#property-photo-img');
  img.hidden = !folder.photo;
  if (folder.photo) img.src = propertyPhotoUrl;
  else img.removeAttribute('src');
  $('#prop-remove').hidden = !folder.photo;
}

async function onPropertyPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || current.kind !== 'folder' || !current.record) return;
  const photo = await compressPhoto(file);
  await db.updateFolder(current.record.id, { photo });
  render();
}

$('#prop-remove').addEventListener('click', async () => {
  if (!(await askConfirm('Remove property photo', 'Remove this property’s photo from its report covers?', 'Remove'))) return;
  await db.updateFolder(current.record.id, { photo: null });
  render();
});
$('#prop-camera').addEventListener('change', onPropertyPhoto);
$('#prop-library').addEventListener('change', onPropertyPhoto);

function row({ icon, name, detail, href, menuLabel, onMenu }) {
  const li = document.createElement('li');
  li.className = 'row';
  const a = document.createElement('a');
  a.className = 'row-open';
  a.href = href;
  a.innerHTML = icon;
  const text = document.createElement('span');
  text.className = 'row-text';
  const n = document.createElement('span');
  n.className = 'row-name';
  n.textContent = name;
  text.append(n);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'row-detail';
    d.textContent = detail;
    text.append(d);
  }
  a.append(text);
  const more = document.createElement('button');
  more.className = 'row-more';
  more.setAttribute('aria-label', menuLabel);
  more.innerHTML = MORE_ICON;
  more.addEventListener('click', onMenu);
  li.append(a, more);
  return li;
}

function folderRow(folder) {
  return row({
    icon: FOLDER_ICON,
    name: folder.name,
    href: folderHref(folder.id),
    menuLabel: `Options for ${folder.name}`,
    onMenu: () => folderMenu(folder),
  });
}

function reportRow(report) {
  return row({
    icon: REPORT_ICON,
    name: report.name,
    detail: formatDate(report.date),
    href: reportHref(report.id),
    menuLabel: `Options for ${report.name}`,
    onMenu: () => reportMenu(report),
  });
}

async function folderMenu(folder) {
  const action = await askAction(folder.name, [
    { label: 'Rename', value: 'rename' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'rename') {
    const name = await askName('Rename folder', 'Save', folder.name);
    if (!name || name === folder.name) return;
    await db.renameFolder(folder.id, name);
    render();
  }
  if (action === 'delete') {
    const { folders, reports } = await db.countContents(folder.id);
    const inside = [folders && plural(folders, 'folder'), reports && plural(reports, 'report')].filter(Boolean);
    let text = `Delete “${folder.name}”?`;
    if (inside.length) text += ` It contains ${inside.join(' and ')}, which will also be deleted.`;
    text += ' This can’t be undone.';
    if (!(await askConfirm('Delete folder', text))) return;
    await db.deleteFolder(folder.id);
    render();
  }
}

async function reportMenu(report) {
  const action = await askAction(report.name, [
    { label: 'Export PDF', value: 'pdf' },
    { label: 'Coordinates list', value: 'coords' },
    { label: 'Edit name and date', value: 'edit' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'pdf') await exportPdf(report);
  if (action === 'coords') await showCoordinates(report);
  if (action === 'edit') await editReport(report);
  if (action === 'delete') await removeReport(report);
}

async function newInFolder() {
  const folderId = current.id;
  // A report always belongs to a property, so the top level only holds folders.
  const action = folderId === db.ROOT
    ? 'folder'
    : await askAction('Add to this folder', [
        { label: 'New wet check report', value: 'report' },
        { label: 'New folder', value: 'folder' },
      ]);
  if (action === 'folder') {
    const name = await askName('New folder', 'Create');
    if (!name) return;
    await db.createFolder(name, folderId);
    render();
  }
  if (action === 'report') {
    const details = await askReportDetails('New wet check report', 'Create', { name: 'Wet check', date: today() });
    if (!details) return;
    const report = await db.createReport(folderId, details.name, details.date);
    location.hash = reportHref(report.id);
  }
}

// ---------- Report screen ----------

let photoUrls = []; // object URLs for thumbnails, revoked on each render

// The zone a report is being worked in. New findings go into it unless changed.
const zoneOf = (report) => (report.currentZone ?? '1');
const zoneName = (z) => (z ? `Zone ${z}` : 'No zone');

// Next or previous zone: steps the number at the end ("4" -> "5", "A3" -> "A4").
function stepZone(zone, delta) {
  const m = zone.match(/^(.*?)(\d+)$/);
  if (!m) return zone ? zone : '1';
  return m[1] + Math.max(1, Number(m[2]) + delta);
}

const byZone = (a, b) => {
  if (!a) return 1; // findings with no zone go last
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

// [[zone, findings], ...] in zone order; findings keep the order they were added.
function groupByZone(findings) {
  const groups = new Map();
  for (const f of findings) {
    const z = f.zone || '';
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(f);
  }
  return [...groups.keys()].sort(byZone).map((z) => [z, groups.get(z)]);
}

async function renderReport(id) {
  const report = await db.getReport(id);
  if (!report) return (location.hash = '#/');
  const path = await db.getPath(report.folderId);
  current = { kind: 'report', id, record: report };

  setHeader({
    title: report.name,
    subtitle: formatDate(report.date),
    crumbs: crumbsFor(path),
    back: true,
    more: true,
  });

  const zone = zoneOf(report);
  $('#zone-value').textContent = zoneName(zone);
  $('#add-finding-label').textContent = zone ? `Add finding to Zone ${zone}` : 'Add finding';
  $('#zone-prev').disabled = !/\d+$/.test(zone) || /^(.*?\D)?0*1$/.test(zone);

  const findings = await db.listFindings(id);
  for (const u of photoUrls) URL.revokeObjectURL(u);
  photoUrls = [];

  const sections = groupByZone(findings).map(([z, items]) => {
    const section = document.createElement('section');
    section.className = 'zone-group' + (z === zone ? ' current' : '');
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = `${zoneName(z)} · ${plural(items.length, 'finding')}`;
    const ul = document.createElement('ul');
    ul.className = 'cards';
    ul.append(...items.map((f, i) => findingCard(f, i + 1)));
    section.append(h, ul);
    return section;
  });
  $('#finding-groups').replaceChildren(...sections);
  $('#report-empty').hidden = findings.length > 0;
  showView('report');
  fillMissingCities(findings);
}

// Photos taken offline get their city once there's a connection.
let fillingCities = false;
async function fillMissingCities(findings) {
  if (fillingCities || !navigator.onLine) return;
  const todo = findings.filter((f) => f.stamp && f.stamp.lat != null && !f.stamp.city);
  if (!todo.length) return;
  fillingCities = true;
  let changed = false;
  for (const f of todo) {
    const city = await lookupCity(f.stamp.lat, f.stamp.lon);
    if (!city) continue;
    const latest = await db.getFinding(f.id);
    if (!latest || !latest.stamp) continue;
    await db.saveFinding(latest.reportId, { ...latest, stamp: { ...latest.stamp, city } }, latest.id);
    changed = true;
  }
  fillingCities = false;
  if (changed && current.kind === 'report') render();
}

window.addEventListener('online', () => current && current.kind === 'report' && render());

async function setZone(zone) {
  const report = await db.updateReport(current.id, { currentZone: zone });
  current.record = report;
  await render();
}

$('#zone-next').addEventListener('click', () => setZone(stepZone(zoneOf(current.record), 1)));
$('#zone-prev').addEventListener('click', () => setZone(stepZone(zoneOf(current.record), -1)));
$('#zone-current').addEventListener('click', async () => {
  const z = await askName('Current zone', 'Set', zoneOf(current.record), { allowEmpty: true, placeholder: 'Zone number', numeric: true });
  if (z !== null) setZone(z);
});

function findingCard(finding, number) {
  const li = document.createElement('li');
  li.dataset.id = finding.id;
  li.className = 'card';
  const btn = document.createElement('button');
  btn.className = 'card-main';
  btn.addEventListener('click', () => editFinding(finding));

  if (finding.photo) {
    const img = document.createElement('img');
    const url = URL.createObjectURL(finding.photo);
    photoUrls.push(url);
    img.src = url;
    img.alt = '';
    img.className = 'card-photo';
    btn.append(img);
  }
  const body = document.createElement('div');
  body.className = 'card-body';
  const head = document.createElement('div');
  head.className = 'card-issue';
  head.textContent = `${number}. ${finding.issue}`;
  body.append(head);
  if (finding.note) {
    const n = document.createElement('div');
    n.className = 'card-note';
    n.textContent = finding.note;
    body.append(n);
  }
  btn.append(body);
  li.append(btn);
  if (finding.stamp) li.append(locationBox(finding.stamp));
  return li;
}

// Coordinates with Map and Copy buttons, and city, accuracy and time underneath.
function locationBox(stamp) {
  const box = document.createElement('div');
  box.className = 'loc-box';
  const text = document.createElement('div');
  text.className = 'loc-text';
  const coords = document.createElement('div');
  coords.className = 'loc-coords';
  coords.textContent = !stamp ? 'Added with the photo' : stamp.lat != null ? coordsText(stamp) : 'No location';
  const details = document.createElement('div');
  details.className = 'loc-details';
  details.textContent = stampDetails(stamp);
  details.hidden = !details.textContent;
  text.append(coords, details);
  box.append(text);
  if (stamp && stamp.lat != null) box.append(mapButtons(stamp));
  return box;
}

function mapButtons(stamp) {
  const wrap = document.createElement('div');
  wrap.className = 'loc-actions';
  const map = document.createElement('a');
  map.className = 'btn small outline';
  map.href = mapUrl(stamp);
  map.target = '_blank';
  map.rel = 'noopener';
  map.textContent = 'Map';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn small outline';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    const ok = await copyText(coordsText(stamp));
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  wrap.append(map, copy);
  return wrap;
}

// Every finding's coordinates in one list, for finding the repairs later.
async function showCoordinates(report) {
  const findings = await db.listFindings(report.id);
  const rows = [];
  for (const [z, items] of groupByZone(findings)) {
    items.forEach((f, i) => {
      if (f.stamp && f.stamp.lat != null) rows.push({ label: `${zoneName(z)} · ${i + 1}. ${f.issue}`, stamp: f.stamp });
    });
  }
  $('#coords-list').replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'coords-row';
    const text = document.createElement('div');
    text.className = 'loc-text';
    const label = document.createElement('div');
    label.className = 'coords-label';
    label.textContent = r.label;
    const coords = document.createElement('div');
    coords.className = 'loc-coords';
    coords.textContent = coordsText(r.stamp);
    text.append(label, coords);
    li.append(text, mapButtons(r.stamp));
    return li;
  }));
  $('#coords-empty').hidden = rows.length > 0;
  $('#coords-copy').hidden = rows.length === 0;
  const copyAll = $('#coords-copy');
  copyAll.onclick = async () => {
    const text = [`${report.name} (${formatDate(report.date)})`, ...rows.map((r) => `${r.label}: ${coordsText(r.stamp)}`)].join('\n');
    const ok = await copyText(text);
    copyAll.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copyAll.textContent = 'Copy all'), 1500);
  };
  await showDialog($('#coords-dialog'));
}

// ---------- PDF export ----------

let pdfUrl = null;

async function exportPdf(report) {
  const dialog = $('#pdf-dialog');
  const share = $('#pdf-share');
  const download = $('#pdf-download');
  const open = $('#pdf-open');
  $('#pdf-title').textContent = 'Making PDF…';
  $('#pdf-text').textContent = 'This takes a few seconds for reports with lots of photos.';
  share.hidden = download.hidden = open.hidden = true;
  const closed = showDialog(dialog);

  try {
    const [path, findings, logo, companyName] = await Promise.all([
      db.getPath(report.folderId),
      db.listFindings(report.id),
      db.getSetting('companyLogo'),
      db.getSetting('companyName'),
    ]);
    const property = path.map((f) => f.name);
    const blob = await buildReportPdf({
      report,
      property,
      propertyPhoto: path.length ? path[0].photo || null : null, // set on the top-level property folder
      logo,
      companyName,
      groups: groupByZone(findings),
      zoneName,
    });
    const name = pdfFileName(property, report);
    const file = new File([blob], name, { type: 'application/pdf' });

    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(blob);
    download.href = open.href = pdfUrl;
    download.download = name;

    $('#pdf-title').textContent = 'PDF ready';
    $('#pdf-text').textContent = `${name} (${Math.max(1, Math.round(blob.size / 1024))} KB)`;
    // Phones get a Share button (save to Files, email, text); others get a download.
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    share.hidden = !canShare;
    download.hidden = !!canShare;
    open.hidden = false;
    share.onclick = async () => {
      try {
        await navigator.share({ files: [file], title: name });
      } catch {
        // Share sheet dismissed.
      }
    };
  } catch (err) {
    $('#pdf-title').textContent = 'Couldn’t make the PDF';
    $('#pdf-text').textContent = err && err.message ? err.message : 'Something went wrong. Try again.';
  }
  await closed;
}

async function askReportDetails(title, submitLabel, initial) {
  $('#report-dialog-title').textContent = title;
  $('#report-submit').textContent = submitLabel;
  $('#report-name').value = initial.name;
  $('#report-date').value = initial.date;
  const result = await showDialog($('#report-dialog'));
  const name = $('#report-name').value.trim();
  const date = $('#report-date').value;
  return result === 'ok' && name && date ? { name, date } : null;
}

async function editReport(report) {
  const details = await askReportDetails('Edit report', 'Save', report);
  if (!details) return;
  await db.updateReport(report.id, details);
  render();
}

async function removeReport(report) {
  const n = (await db.listFindings(report.id)).length;
  let text = `Delete “${report.name}” from ${formatDate(report.date)}?`;
  if (n) text += ` Its ${plural(n, 'finding')} will also be deleted.`;
  text += ' This can’t be undone.';
  if (!(await askConfirm('Delete report', text))) return;
  await db.deleteReport(report.id);
  if (current.kind === 'report') location.hash = folderHref(report.folderId);
  else render();
}

// ---------- Finding form ----------

const form = {
  dialog: $('#finding-dialog'),
  title: $('#finding-title'),
  preview: $('#photo-preview'),
  img: $('#photo-img'),
  location: $('#finding-location'),
  locStatus: $('#location-status'),
  error: $('#photo-error'),
  issue: $('#finding-issue'),
  zone: $('#finding-zone'),
  note: $('#finding-note'),
  del: $('#finding-delete'),
  photo: null, // compressed Blob
  photoStamp: null, // { takenAt, lat, lon, accuracy, city }
  busy: false,
  locating: null, // promise while waiting on GPS for the current photo
  pendingPosition: null, // GPS request started when the camera opens
  pick: 0, // bumps on every photo pick so a slow lookup can't overwrite a newer photo
};

function setPhoto(blob, stamp = null) {
  form.photo = blob;
  if (form.img.src) URL.revokeObjectURL(form.img.src);
  form.img.removeAttribute('src');
  if (blob) form.img.src = URL.createObjectURL(blob);
  form.preview.hidden = !blob;
  setStamp(stamp);
}

function setStamp(stamp) {
  form.photoStamp = stamp;
  form.location.replaceChildren(locationBox(stamp));
}

function showLocStatus(msg) {
  form.locStatus.textContent = msg;
  form.locStatus.hidden = !msg;
}

function showPhotoError(msg) {
  form.error.textContent = msg;
  form.error.hidden = !msg;
}

async function onPhotoPicked(e, fromCamera) {
  const file = e.target.files[0];
  e.target.value = ''; // lets the same photo be picked again
  if (!file) return;
  const pick = ++form.pick;
  showPhotoError('');
  showLocStatus('');
  form.busy = true;
  let exif;
  try {
    [exif] = await Promise.all([readExif(file), compressPhoto(file).then((b) => (form.photo = b))]);
  } catch {
    form.busy = false;
    showPhotoError('That photo couldn’t be read. Try another one.');
    return;
  }
  form.busy = false;
  if (pick !== form.pick) return;

  // Camera: now, and the phone's GPS unless the camera already tagged the photo.
  // Library: whatever the photo itself recorded, since it may be from another day or place.
  const stamp = { takenAt: exif.takenAt || (fromCamera ? Date.now() : file.lastModified || null) };
  if (exif.lat != null) Object.assign(stamp, { lat: exif.lat, lon: exif.lon });
  setPhoto(form.photo, stamp);

  if (stamp.lat == null && fromCamera) {
    showLocStatus('Getting location…');
    form.locating = (form.pendingPosition || getPosition()).then((pos) => {
      if (pick !== form.pick) return;
      form.locating = null;
      if (pos) {
        setStamp({ ...form.photoStamp, ...pos });
        showLocStatus('');
      } else {
        showLocStatus('Location unavailable. Allow location for this site in your phone’s settings to add it.');
      }
    });
    await form.locating;
  } else if (stamp.lat == null) {
    showLocStatus('This photo has no location saved in it.');
  }
  form.pendingPosition = null;

  const s = form.photoStamp;
  if (pick === form.pick && s && s.lat != null) {
    const city = await lookupCity(s.lat, s.lon);
    if (city && pick === form.pick) setStamp({ ...form.photoStamp, city });
  }
}

// Start GPS as the camera opens, so it's ready by the time the photo is taken.
$('#photo-camera').addEventListener('click', () => {
  form.pendingPosition = getPosition();
});
$('#photo-camera').addEventListener('change', (e) => onPhotoPicked(e, true));
$('#photo-library').addEventListener('change', (e) => onPhotoPicked(e, false));

$('#finding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (form.busy) return;
  if (!form.photo) {
    showPhotoError('Add a photo first.');
    return;
  }
  if (form.locating) {
    $('#finding-save').disabled = true;
    await form.locating;
    $('#finding-save').disabled = false;
  }
  form.dialog.close('ok');
});

form.del.addEventListener('click', () => form.dialog.close('delete'));

async function fillIssues(selected) {
  const issues = await loadIssues();
  const options = [...issues];
  // Keep an issue that has since been removed from the list, so editing doesn't lose it.
  if (selected && !options.includes(selected)) options.unshift(selected);
  const placeholder = new Option('Choose an issue', '');
  placeholder.disabled = true;
  form.issue.replaceChildren(placeholder, ...options.map((o) => new Option(o, o)));
  form.issue.value = selected || '';
}

async function openFindingForm(finding) {
  form.title.textContent = finding ? 'Edit finding' : 'New finding';
  form.del.hidden = !finding;
  showPhotoError('');
  showLocStatus('');
  form.pick++;
  form.locating = null;
  setPhoto(finding ? finding.photo : null, finding ? finding.stamp || null : null);
  await fillIssues(finding ? finding.issue : '');
  form.zone.value = finding ? finding.zone : zoneOf(current.record);
  form.note.value = finding ? finding.note : '';
  form.dialog.scrollTop = 0;
  const result = await showDialog(form.dialog);
  const fields = {
    photo: form.photo,
    stamp: form.photoStamp,
    issue: form.issue.value,
    zone: form.zone.value.trim(),
    note: form.note.value.trim(),
  };
  setPhoto(null);
  return { result, fields };
}

async function addFinding() {
  const { result, fields } = await openFindingForm(null);
  if (result !== 'ok') return;
  const saved = await db.saveFinding(current.id, fields);
  await render();
  // Show the finding just added.
  const card = document.querySelector(`[data-id="${saved.id}"]`);
  if (card) card.scrollIntoView({ block: 'center' });
}

async function editFinding(finding) {
  const { result, fields } = await openFindingForm(finding);
  if (result === 'ok') {
    await db.saveFinding(finding.reportId, fields, finding.id);
    render();
  }
  if (result === 'delete') {
    if (!(await askConfirm('Delete finding', `Delete the “${finding.issue}” finding? This can’t be undone.`))) return;
    await db.deleteFinding(finding.id);
    render();
  }
}

// ---------- Wiring ----------

function showView(kind) {
  $('#folder-view').hidden = kind !== 'folder';
  $('#report-view').hidden = kind !== 'report';
  $('#fab').hidden = kind !== 'folder';
  document.body.classList.toggle('in-report', kind === 'report');
}

// Screens visited in this session, so the on-screen back arrow can step back through
// history (like the phone's back button) instead of stacking up new entries.
const visited = [location.hash || '#/'];
window.addEventListener('hashchange', () => {
  const h = location.hash || '#/';
  if (visited[visited.length - 2] === h) visited.pop();
  else visited.push(h);
});

$('#back').addEventListener('click', () => {
  const parent = current.kind === 'report'
    ? folderHref(current.record.folderId)
    : folderHref(current.record ? current.record.parentId : db.ROOT);
  if (visited[visited.length - 2] === parent) history.back();
  else location.hash = parent;
});

$('#export-pdf').addEventListener('click', () => exportPdf(current.record));
$('#show-coords').addEventListener('click', () => showCoordinates(current.record));
$('#header-more').addEventListener('click', () => current.kind === 'report' && reportMenu(current.record));

$('#fab').addEventListener('click', newInFolder);
$('#add-finding').addEventListener('click', addFinding);

window.addEventListener('hashchange', render);

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

if ('serviceWorker' in navigator) {
  // When an update takes over, reload once so the page and its scripts are the same version.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('./sw.js');
}

render();
