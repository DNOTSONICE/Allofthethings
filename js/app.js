import * as db from './db.js';
import { showDialog, askName, askAction, askConfirm, plural, formatDate, today } from './ui.js';
import { compressPhoto, compressLogo } from './photo.js';
import { loadIssueList, saveIssueList, resetIssueList, findIssue, toPrice, formatMoney, findingPrice, buildEstimate } from './issues.js';
import { buildReportPdf, pdfFileName, DEFAULT_ACCENT } from './pdf.js';
import { createBackup, readBackup, restoreBackup } from './backup.js';
import { getPosition, readExif, lookupCity, coordsText, mapUrl, stampDetails, copyText, formatTime } from './location.js';

const $ = (sel) => document.querySelector(sel);

// Shown on the home screen so it's easy to tell which version a phone is running.
// Keep in step with VERSION in sw.js.
const APP_VERSION = 17;

const DEFAULT_DISCLAIMER = '*Troubleshooting required. Additional proposals may be required to complete this repair.';

// ---------- Error banner ----------
// Shows problems on screen instead of failing silently.

let toastTimer = null;
function showToast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('ok', kind === 'ok');
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
// #/settings    settings: company, issues and prices, backup
// #/issues      the issue list and prices
// Using the URL hash means the phone's back button works.

function route() {
  if (location.hash === '#/issues') return { kind: 'issues', id: '' };
  if (location.hash === '#/settings') return { kind: 'settings', id: '' };
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
  else if (r.kind === 'issues') await renderIssues();
  else if (r.kind === 'settings') await renderSettings();
  else await renderFolder(r.id);
  // Start at the top when moving to a different screen, but not when refreshing the same one.
  const screen = `${r.kind}:${r.id}`;
  if (screen !== lastScreen) $('main').scrollTo(0, 0);
  lastScreen = screen;
}

function setHeader({ title, subtitle = '', crumbs = [], back = false, more = false, settings = false }) {
  $('#settings-btn').hidden = !settings;
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
    settings: !here,
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
  await renderBackupCard(!here);
  renderPropertyPhoto(path.length === 1 ? here : null);
  $('#app-version').hidden = !!here;
  $('#app-version').textContent = `App version ${APP_VERSION}`;
  showView('folder');
}

// ---------- Company logo (home screen) ----------

let companyLogoUrl = null;

// ---------- Settings screen ----------

async function renderSettings() {
  current = { kind: 'settings', id: '', record: null };
  setHeader({ title: 'Settings', back: true });
  await Promise.all([renderCompanyCard(), renderIssuesCard(), renderBackupCard(false)]);
  $('#settings-version').textContent = `App version ${APP_VERSION}`;
  showView('settings');
}

$('#settings-btn').addEventListener('click', () => (location.hash = '#/settings'));

async function renderCompanyCard() {
  const card = $('#company-card');
  card.hidden = false;
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
  let accent = (await db.getSetting('accentColor')) || DEFAULT_ACCENT;
  renderSwatches(accent, (c) => (accent = c));
  const result = await showDialog($('#company-dialog'));
  if (url) URL.revokeObjectURL(url);
  if (result !== 'ok') return;
  await db.setSetting('companyLogo', logo);
  await db.setSetting('companyName', $('#company-name').value.trim());
  await db.setSetting('accentColor', accent);
  render();
}

$('#company-card').addEventListener('click', editCompany);

const ACCENT_PRESETS = [
  ['Blue', DEFAULT_ACCENT],
  ['Navy', '#1b2a4a'],
  ['Teal', '#0e7490'],
  ['Green', '#2e7d32'],
  ['Red', '#b3261e'],
  ['Orange', '#d9730d'],
  ['Charcoal', '#3c4043'],
];

// Preset color dots plus a "Custom" picker for any brand color.
function renderSwatches(selected, onPick) {
  const box = $('#accent-swatches');
  const make = (name, hex) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = hex;
    b.title = name;
    b.setAttribute('aria-label', name);
    b.dataset.hex = hex;
    b.addEventListener('click', () => pick(hex));
    return b;
  };
  const custom = document.createElement('label');
  custom.className = 'swatch custom';
  custom.title = 'Custom color';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = selected;
  input.addEventListener('input', () => pick(input.value));
  custom.append(input);
  const pick = (hex) => {
    selected = hex.toLowerCase();
    onPick(selected);
    for (const el of box.querySelectorAll('.swatch')) {
      el.classList.toggle('on', el.dataset.hex === selected || (el === custom && !ACCENT_PRESETS.some(([, h]) => h === selected)));
    }
    custom.style.background = ACCENT_PRESETS.some(([, h]) => h === selected) ? '' : selected;
  };
  box.replaceChildren(...ACCENT_PRESETS.map(([n, h]) => make(n, h)), custom);
  pick(selected);
}

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

const reportDetail = (r) => [formatDate(r.date), r.subdivision].filter(Boolean).join(' · ');

function reportRow(report) {
  return row({
    icon: REPORT_ICON,
    name: report.name,
    detail: reportDetail(report),
    href: reportHref(report.id),
    menuLabel: `Options for ${report.name}`,
    onMenu: () => reportMenu(report),
  });
}

async function folderMenu(folder) {
  const action = await askAction(folder.name, [
    { label: 'Rename', value: 'rename' },
    { label: 'Back up or share this property', value: 'backup' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'backup') await backUp(folder);
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
    { label: report.estimate ? 'Turn off repair estimate' : 'Turn on repair estimate', value: 'estimate' },
    { label: 'Edit report details', value: 'edit' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'estimate') {
    await db.updateReport(report.id, { estimate: !report.estimate });
    render();
  }
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
    const estimate = !!(await db.getSetting('estimateDefault')); // last choice made
    const details = await askReportDetails('New wet check report', 'Create', { name: 'Wet check', date: today(), estimate });
    if (!details) return;
    await db.setSetting('estimateDefault', details.estimate);
    const report = await db.createReport(folderId, details.name, details.date, { estimate: details.estimate, subdivision: details.subdivision });
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
    subtitle: reportDetail(report),
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
  const list = report.estimate ? await loadIssueList() : null;
  renderEstimateBar(report, findings, list);

  const sections = groupByZone(findings).map(([z, items]) => {
    const section = document.createElement('section');
    section.className = 'zone-group' + (z === zone ? ' current' : '');
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = `${zoneName(z)} · ${plural(items.length, 'finding')}`;
    const ul = document.createElement('ul');
    ul.className = 'cards';
    ul.append(...items.map((f, i) => findingCard(f, i + 1, list)));
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

function findingCard(finding, number, list = null) {
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
    const more = (finding.morePhotos || []).length;
    if (more) {
      const count = document.createElement('span');
      count.className = 'photo-count';
      count.textContent = `+${plural(more, 'photo')}`;
      btn.append(count);
    }
  }
  const body = document.createElement('div');
  body.className = 'card-body';
  const head = document.createElement('div');
  head.className = 'card-issue';
  head.textContent = `${number}. ${finding.issue}`;
  body.append(head);
  if (list) {
    const price = findingPrice(finding, list);
    const p = document.createElement('div');
    p.className = 'card-price' + (price == null ? ' none' : '');
    p.textContent = price == null ? 'No price' : formatMoney(price);
    body.append(p);
  }
  if (finding.note) {
    const n = document.createElement('div');
    n.className = 'card-note';
    n.textContent = finding.note;
    body.append(n);
  }
  if (finding.disclaimer) {
    const d = document.createElement('div');
    d.className = 'card-disclaimer';
    d.textContent = finding.disclaimer;
    body.append(d);
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

let fileUrl = null;

// Shows the "file ready" dialog: build() makes the file while a working message shows,
// then phones get Share (save to Files, email, text) and others get Download.
async function deliverFile({ working, workingText, ready, failed, canOpen = false, build }) {
  const dialog = $('#pdf-dialog');
  const share = $('#pdf-share');
  const download = $('#pdf-download');
  const open = $('#pdf-open');
  $('#pdf-title').textContent = working;
  $('#pdf-text').textContent = workingText;
  share.hidden = download.hidden = open.hidden = true;
  const closed = showDialog(dialog);

  try {
    const { blob, name, detail } = await build();
    const file = new File([blob], name, { type: blob.type });
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(blob);
    download.href = open.href = fileUrl;
    download.download = name;

    $('#pdf-title').textContent = ready;
    const size = blob.size > 1024 * 1024 ? `${(blob.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
    $('#pdf-text').textContent = `${name} (${size})${detail ? `. ${detail}` : ''}`;
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    share.hidden = !canShare;
    download.hidden = !!canShare;
    open.hidden = !canOpen;
    share.onclick = async () => {
      try {
        await navigator.share({ files: [file], title: name });
      } catch {
        // Share sheet dismissed.
      }
    };
  } catch (err) {
    $('#pdf-title').textContent = failed;
    $('#pdf-text').textContent = err && err.message ? err.message : 'Something went wrong. Try again.';
  }
  await closed;
}

function exportPdf(report) {
  return deliverFile({
    working: 'Making PDF…',
    workingText: 'This takes a few seconds for reports with lots of photos.',
    ready: 'PDF ready',
    failed: 'Couldn’t make the PDF',
    canOpen: true,
    build: async () => {
      const [path, findings, logo, companyName, accent] = await Promise.all([
        db.getPath(report.folderId),
        db.listFindings(report.id),
        db.getSetting('companyLogo'),
        db.getSetting('companyName'),
        db.getSetting('accentColor'),
      ]);
      const property = path.map((f) => f.name);
      const estimate = report.estimate ? buildEstimate(findings, await loadIssueList()) : null;
      const blob = await buildReportPdf({
        estimate,
        report,
        property,
        propertyPhoto: path.length ? path[0].photo || null : null, // set on the top-level property folder
        logo,
        companyName,
        accent: accent || DEFAULT_ACCENT,
        groups: groupByZone(findings),
        zoneName,
      });
      return { blob, name: pdfFileName(property, report) };
    },
  });
}

// ---------- Backup and restore ----------

const countsText = (c) => [plural(c.folders, 'folder'), plural(c.reports, 'report'), plural(c.findings, 'finding')].join(', ');

// The home screen keeps a backup reminder card; Settings has the same entry.
async function renderBackupCard(show) {
  $('#backup-card').hidden = !show;
  const last = await db.getSetting('lastBackupAt');
  for (const detail of [$('#backup-card-detail'), $('#settings-backup-detail')]) {
    detail.textContent = last ? `Last backup: ${formatTime(last)}` : 'Last backup: never. Tap to back up.';
    // Nudge when it's been more than a week.
    detail.classList.toggle('warn', !last || Date.now() - last > 7 * 24 * 3600 * 1000);
  }
}

function backUp(folder = null) {
  return deliverFile({
    working: 'Making backup…',
    workingText: 'Packing up your reports and photos.',
    ready: 'Backup ready',
    failed: 'Couldn’t make the backup',
    build: async () => {
      const { blob, name, counts } = await createBackup(APP_VERSION, folder ? folder.id : null);
      return { blob, name, detail: `Includes ${countsText(counts)}. Save it somewhere off this phone.` };
    },
  }).then(() => render());
}

async function openBackupDialog() {
  const last = await db.getSetting('lastBackupAt');
  $('#backup-last').textContent = last ? `Last full backup: ${formatTime(last)}` : 'No full backup made on this phone yet.';
  showDialog($('#backup-dialog'));
}
$('#backup-card').addEventListener('click', openBackupDialog);
$('#settings-backup-card').addEventListener('click', openBackupDialog);

$('#backup-all').addEventListener('click', () => {
  $('#backup-dialog').close('cancel');
  backUp();
});

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('#backup-dialog').close('cancel');
  let backup;
  try {
    backup = await readBackup(file);
  } catch (err) {
    await askConfirm('Can’t restore', err.message, 'OK');
    return;
  }
  const what = backup.kind === 'property' ? `the property “${backup.name}”` : 'a full backup';
  const when = backup.exportedAt ? ` from ${formatTime(backup.exportedAt)}` : '';
  const actions = [{ label: 'Add to this phone', value: 'merge' }];
  if (backup.kind !== 'property') actions.push({ label: 'Replace everything on this phone', value: 'replace', danger: true });
  const choice = await askAction(`This file has ${what}${when}: ${countsText(backup.counts)}.`, actions);
  if (!choice) return;
  if (choice === 'replace') {
    const ok = await askConfirm(
      'Replace everything?',
      'Everything on this phone will be deleted and replaced with the backup. Anything not in the backup will be lost. This can’t be undone.',
      'Replace'
    );
    if (!ok) return;
  }
  await restoreBackup(backup, { replace: choice === 'replace' });
  location.hash = '#/';
  await render();
  showToast(`Restored ${countsText(backup.counts)}.`, 'ok');
});

async function askReportDetails(title, submitLabel, initial) {
  $('#report-dialog-title').textContent = title;
  $('#report-submit').textContent = submitLabel;
  $('#report-name').value = initial.name;
  $('#report-date').value = initial.date;
  $('#report-subdivision').value = initial.subdivision || '';
  $('#report-estimate').checked = !!initial.estimate;
  const result = await showDialog($('#report-dialog'));
  const name = $('#report-name').value.trim();
  const date = $('#report-date').value;
  const estimate = $('#report-estimate').checked;
  const subdivision = $('#report-subdivision').value.trim();
  return result === 'ok' && name && date ? { name, date, subdivision, estimate } : null;
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

// ---------- Repair estimate (report screen) ----------

function renderEstimateBar(report, findings, list) {
  const bar = $('#estimate-bar');
  bar.hidden = !list;
  if (!list) return;
  const est = buildEstimate(findings, list);
  $('#estimate-total').textContent = formatMoney(est.total);
  const detail = $('#estimate-detail');
  detail.classList.toggle('warn', est.unpriced > 0);
  if (!findings.length) detail.textContent = 'Findings are priced from your price list as you add them.';
  else if (est.unpriced) detail.textContent = `${plural(est.unpriced, 'finding')} without a price, not included. Tap to see the estimate.`;
  else detail.textContent = `${plural(findings.length, 'finding')} priced. Tap to see the estimate.`;
}

async function showEstimate(report) {
  const [findings, list] = await Promise.all([db.listFindings(report.id), loadIssueList()]);
  const est = buildEstimate(findings, list);
  $('#estimate-lines').replaceChildren(...est.lines.map((l) => {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'line-text';
    text.textContent = l.issue;
    const detail = document.createElement('span');
    detail.className = 'line-detail';
    const zones = l.zones.length ? ` · ${l.zones.length === 1 ? 'Zone' : 'Zones'} ${l.zones.join(', ')}` : '';
    detail.textContent = `${l.qty} × ${l.unit == null ? 'no price' : formatMoney(l.unit)}${zones}`;
    text.append(detail);
    const amount = document.createElement('span');
    amount.className = 'line-amount' + (l.amount == null ? ' none' : '');
    amount.textContent = l.amount == null ? 'No price' : formatMoney(l.amount);
    li.append(text, amount);
    return li;
  }));
  $('#estimate-sum').textContent = formatMoney(est.total);
  const warn = $('#estimate-unpriced');
  warn.hidden = !est.unpriced;
  warn.textContent = `${plural(est.unpriced, 'finding')} without a price ${est.unpriced === 1 ? 'isn’t' : 'aren’t'} included. Set prices in Issues and prices, or type a price on the finding.`;
  $('#estimate-prices').onclick = () => {
    $('#estimate-dialog').close('cancel');
    location.hash = '#/issues';
  };
  await showDialog($('#estimate-dialog'));
}

$('#estimate-bar').addEventListener('click', () => showEstimate(current.record));

// ---------- Issues and prices ----------

async function renderIssuesCard() {
  $('#issues-card').hidden = false;
  const list = await loadIssueList();
  const all = list.groups.flatMap((g) => g.issues);
  const on = all.filter((i) => !i.off).length;
  const priced = all.filter((i) => i.price != null).length;
  $('#issues-card-detail').textContent = `${plural(on, 'issue')} in use, ${priced} priced. Tap to edit.`;
}

$('#issues-card').addEventListener('click', () => (location.hash = '#/issues'));

let issueList = null; // what the issues screen is showing

async function renderIssues() {
  current = { kind: 'issues', id: '', record: null };
  setHeader({ title: 'Issues and prices', back: true });
  issueList = await loadIssueList();
  $('#issue-groups').replaceChildren(...issueList.groups.map((g) => {
    const section = document.createElement('section');
    const head = document.createElement('div');
    head.className = 'group-head';
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = g.name || 'Issues';
    const more = document.createElement('button');
    more.className = 'row-more';
    more.setAttribute('aria-label', `Options for ${g.name || 'this group'}`);
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', () => groupMenu(g));
    head.append(h, more);

    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.issues.map((issue) => issueRow(g, issue)));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small outline add-issue';
    add.textContent = '+ Add issue';
    add.addEventListener('click', () => addIssue(g));
    section.append(head, ul, add);
    return section;
  }));
  showView('issues');
}

function issueRow(group, issue) {
  const li = document.createElement('li');
  li.className = 'issue-row' + (issue.off ? ' off' : '');
  const toggle = document.createElement('label');
  toggle.className = 'issue-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !issue.off;
  box.setAttribute('aria-label', `Use ${issue.name}`);
  box.addEventListener('change', async () => {
    issue.off = !box.checked;
    li.classList.toggle('off', issue.off);
    await saveIssueList(issueList);
  });
  toggle.append(box);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'issue-main';
  const name = document.createElement('span');
  name.className = 'issue-name';
  name.textContent = issue.name;
  const price = document.createElement('span');
  price.className = 'issue-price' + (issue.price == null ? ' none' : '');
  price.textContent = issue.price == null ? 'No price' : formatMoney(issue.price);
  main.append(name, price);
  main.addEventListener('click', () => editIssue(group, issue));
  li.append(toggle, main);
  return li;
}

// Name and price dialog. Resolves with { name, price }, 'delete', or null.
async function askIssue(title, issue) {
  $('#issue-dialog-title').textContent = title;
  $('#issue-name').value = issue ? issue.name : '';
  $('#issue-price').value = issue && issue.price != null ? issue.price.toFixed(2) : '';
  $('#issue-delete').hidden = !issue;
  $('#issue-rename-hint').hidden = !issue;
  const err = $('#issue-error');
  err.hidden = true;
  $('#issue-delete').onclick = () => $('#issue-dialog').close('delete');
  for (;;) {
    const result = await showDialog($('#issue-dialog'));
    if (result === 'delete') return 'delete';
    if (result !== 'ok') return null;
    const name = $('#issue-name').value.trim();
    const rawPrice = $('#issue-price').value.trim();
    const price = toPrice(rawPrice);
    const taken = findIssue(issueList, name);
    let problem = '';
    if (!name) problem = 'Give the issue a name.';
    else if (taken && taken !== issue) problem = 'That issue is already on the list.';
    else if (rawPrice && price == null) problem = 'Enter the price as a number, like 45 or 45.50.';
    if (!problem) return { name, price };
    err.textContent = problem;
    err.hidden = false;
  }
}

async function editIssue(group, issue) {
  const r = await askIssue('Edit issue', issue);
  if (!r) return;
  if (r === 'delete') {
    const ok = await askConfirm('Delete issue', `Remove “${issue.name}” from the list? Findings already saved with it keep it. To just hide it, turn it off instead.`);
    if (!ok) return;
    group.issues.splice(group.issues.indexOf(issue), 1);
  } else {
    const from = issue.name;
    Object.assign(issue, r);
    if (from !== r.name) await db.renameIssue(from, r.name);
  }
  await saveIssueList(issueList);
  render();
}

async function addIssue(group) {
  const r = await askIssue(`Add to ${group.name || 'the list'}`, null);
  if (!r || r === 'delete') return;
  group.issues.push({ ...r, off: false });
  await saveIssueList(issueList);
  render();
}

async function groupMenu(group) {
  const action = await askAction(group.name || 'Issues', [
    { label: 'Rename group', value: 'rename' },
    { label: 'Delete group', value: 'delete', danger: true },
  ]);
  if (action === 'rename') {
    const name = await askName('Rename group', 'Save', group.name, { placeholder: 'Group name' });
    if (!name) return;
    group.name = name;
  } else if (action === 'delete') {
    const n = group.issues.length;
    const text = `Delete “${group.name || 'this group'}”${n ? ` and its ${plural(n, 'issue')}` : ''}? Findings already saved keep their issue.`;
    if (!(await askConfirm('Delete group', text))) return;
    issueList.groups.splice(issueList.groups.indexOf(group), 1);
  } else return;
  await saveIssueList(issueList);
  render();
}

$('#add-group').addEventListener('click', async () => {
  const name = await askName('New group', 'Create', '', { placeholder: 'Group name, like Lighting' });
  if (!name) return;
  issueList.groups.push({ name, issues: [] });
  await saveIssueList(issueList);
  await render();
  $('main').scrollTo(0, $('main').scrollHeight);
});

$('#reset-issues').addEventListener('click', async () => {
  const ok = await askConfirm(
    'Reset issue list',
    'Go back to the starting issue list? Your added issues, name changes, on/off choices and all prices will be removed. Findings already saved keep their issue.',
    'Reset'
  );
  if (!ok) return;
  await resetIssueList();
  render();
});

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
  disclaimerCheck: $('#finding-disclaimer'),
  disclaimerText: $('#disclaimer-text'),
  priceBox: $('#price-box'),
  price: $('#finding-price'),
  priceHint: $('#price-hint'),
  list: null, // issue list, for prices
  disclaimer: '', // wording that goes on this finding if the box is checked
  del: $('#finding-delete'),
  photo: null, // compressed Blob
  more: [], // extra photos (compressed Blobs), shown after the main one
  moreUrls: [],
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
  $('#more-photo-buttons').hidden = !blob || form.more.length >= MAX_MORE_PHOTOS;
  setStamp(stamp);
}

const MAX_MORE_PHOTOS = 8;

function renderMorePhotos() {
  for (const u of form.moreUrls) URL.revokeObjectURL(u);
  form.moreUrls = [];
  const list = $('#more-photo-list');
  list.replaceChildren(...form.more.map((blob, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    const url = URL.createObjectURL(blob);
    form.moreUrls.push(url);
    img.src = url;
    img.alt = `Photo ${i + 2}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'thumb-remove';
    del.setAttribute('aria-label', `Remove photo ${i + 2}`);
    del.textContent = '×';
    del.addEventListener('click', () => {
      form.more.splice(i, 1);
      renderMorePhotos();
    });
    li.append(img, del);
    return li;
  }));
  list.hidden = form.more.length === 0;
  $('#more-photo-buttons').hidden = !form.photo || form.more.length >= MAX_MORE_PHOTOS;
}

async function onMorePhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const room = MAX_MORE_PHOTOS - form.more.length;
  showPhotoError(files.length > room ? `Up to ${MAX_MORE_PHOTOS + 1} photos per finding. Only the first ${room} were added.` : '');
  form.busy = true;
  try {
    for (const file of files.slice(0, room)) {
      try {
        form.more.push(await compressPhoto(file));
      } catch {
        showPhotoError('A photo couldn’t be read and was skipped.');
      }
      renderMorePhotos();
    }
  } finally {
    form.busy = false;
  }
}
$('#more-camera').addEventListener('change', onMorePhotos);
$('#more-library').addEventListener('change', onMorePhotos);

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

// ---------- Troubleshooting disclaimer ----------

function setDisclaimer(text, checked = form.disclaimerCheck.checked) {
  form.disclaimer = text;
  form.disclaimerText.textContent = text;
  form.disclaimerCheck.checked = checked;
  $('#disclaimer-box').classList.toggle('on', checked);
}

form.disclaimerCheck.addEventListener('change', () => setDisclaimer(form.disclaimer));

$('#disclaimer-edit').addEventListener('click', async () => {
  const input = $('#disclaimer-input');
  input.value = form.disclaimer;
  $('#disclaimer-reset').onclick = () => (input.value = DEFAULT_DISCLAIMER);
  if ((await showDialog($('#disclaimer-dialog'))) !== 'ok') return;
  const text = input.value.trim();
  if (!text) return;
  await db.setSetting('disclaimer', text);
  setDisclaimer(text, true); // editing it implies wanting it on this finding
});

async function fillIssues(selected) {
  const list = (form.list = await loadIssueList());
  const placeholder = new Option('Choose an issue', '');
  placeholder.disabled = true;
  const options = [placeholder];
  // Keep an issue that has since been turned off or removed, so editing doesn't lose it.
  const shown = (i) => !i.off || i.name === selected;
  const listed = list.groups.some((g) => g.issues.some((i) => i.name === selected && shown(i)));
  if (selected && !listed) options.push(new Option(selected, selected));
  for (const g of list.groups) {
    const items = g.issues.filter(shown).map((i) => new Option(i.name, i.name));
    if (!items.length) continue;
    if (!g.name) {
      options.push(...items);
      continue;
    }
    const og = document.createElement('optgroup');
    og.label = g.name;
    og.append(...items);
    options.push(og);
  }
  form.issue.replaceChildren(...options);
  form.issue.value = selected || '';
}

// The price field shows on reports with an estimate. Blank means "use the price list".
function updatePriceHint() {
  const issue = form.issue.value ? findIssue(form.list, form.issue.value) : null;
  const listPrice = issue ? issue.price : null;
  form.price.placeholder = listPrice != null ? formatMoney(listPrice) : 'No price';
  if (!form.issue.value) form.priceHint.textContent = 'Choose an issue to fill in its price.';
  else if (listPrice != null) form.priceHint.textContent = `Price list: ${formatMoney(listPrice)}. Type a different price for just this finding.`;
  else form.priceHint.textContent = 'This issue has no price yet. Type one here, or set it in Issues and prices on the home screen.';
}
form.issue.addEventListener('change', updatePriceHint);

async function openFindingForm(finding) {
  form.title.textContent = finding ? 'Edit finding' : 'New finding';
  form.del.hidden = !finding;
  showPhotoError('');
  showLocStatus('');
  form.pick++;
  form.locating = null;
  form.more = finding && finding.morePhotos ? [...finding.morePhotos] : [];
  renderMorePhotos();
  setPhoto(finding ? finding.photo : null, finding ? finding.stamp || null : null);
  await fillIssues(finding ? finding.issue : '');
  form.zone.value = finding ? finding.zone : zoneOf(current.record);
  form.note.value = finding ? finding.note : '';
  form.priceBox.hidden = !current.record.estimate;
  form.price.value = finding && finding.price != null ? finding.price.toFixed(2) : '';
  updatePriceHint();
  const saved = (await db.getSetting('disclaimer')) || DEFAULT_DISCLAIMER;
  setDisclaimer(finding && finding.disclaimer ? finding.disclaimer : saved, !!(finding && finding.disclaimer));
  form.dialog.scrollTop = 0;
  const result = await showDialog(form.dialog);
  const fields = {
    photo: form.photo,
    morePhotos: form.more.slice(),
    stamp: form.photoStamp,
    issue: form.issue.value,
    zone: form.zone.value.trim(),
    note: form.note.value.trim(),
    disclaimer: form.disclaimerCheck.checked ? form.disclaimer : '',
    // Kept as is when the price field is hidden. A price equal to the list price isn't stored,
    // so the finding follows later price list changes.
    price: form.priceBox.hidden ? (finding && finding.price != null ? finding.price : null) : toPrice(form.price.value),
  };
  if (fields.price != null && fields.price === findingPrice({ issue: fields.issue }, form.list)) fields.price = null;
  setPhoto(null);
  form.more = [];
  renderMorePhotos();
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
  $('#issues-view').hidden = kind !== 'issues';
  $('#settings-view').hidden = kind !== 'settings';
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
  // Issues and prices opens from Settings or from a report's estimate, so go back to whichever.
  if (current.kind === 'issues' && visited.length > 1) return history.back();
  const parent = current.kind === 'issues'
    ? '#/settings'
    : current.kind === 'settings'
    ? '#/'
    : current.kind === 'report'
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
