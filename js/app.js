import * as db from './db.js';
import { showDialog, askName, askAction, askConfirm, plural, formatDate, today } from './ui.js';
import { compressPhoto, compressLogo } from './photo.js';
import { loadIssueList, saveIssueList, resetIssueList, findIssue, toPrice, formatMoney, findingPrice, buildEstimate, effectiveList, priceSnapshot } from './issues.js';
import { buildReportPdf, pdfFileName, DEFAULT_ACCENT } from './pdf.js';
import { createBackup, readBackup, restoreBackup } from './backup.js';
import { drawSignature } from './signature.js';
import { getPosition, readExif, lookupCity, coordsText, mapUrl, stampDetails, copyText, formatTime } from './location.js';

const $ = (sel) => document.querySelector(sel);

// Shown on the home screen so it's easy to tell which version a phone is running.
// Keep in step with VERSION in sw.js.
const APP_VERSION = 26;

const DEFAULT_DISCLAIMER = '*Troubleshooting required. Additional proposals may be required to complete this repair.';
const DISCLAIMER_HINT = document.querySelector('#disclaimer-dialog .hint').textContent;

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
// #/p/<id>      a property's profile (contact, disclaimer, its own issues and prices)
// #/search      search everything; #/search/<folder id> searches inside one folder
// Using the URL hash means the phone's back button works.

function route() {
  if (location.hash === '#/issues') return { kind: 'issues', id: '' };
  if (location.hash === '#/settings') return { kind: 'settings', id: '' };
  const s = location.hash.match(/^#\/search(?:\/(.+))?$/);
  if (s) return { kind: 'search', id: s[1] ? decodeURIComponent(s[1]) : '' };
  const p = location.hash.match(/^#\/p\/(.+)$/);
  if (p) return { kind: 'profile', id: decodeURIComponent(p[1]) };
  const m = location.hash.match(/^#\/([fr])\/(.+)$/);
  if (!m) return { kind: 'folder', id: db.ROOT };
  return { kind: m[1] === 'r' ? 'report' : 'folder', id: decodeURIComponent(m[2]) };
}

const folderHref = (id) => (id === db.ROOT ? '#/' : `#/f/${encodeURIComponent(id)}`);
const reportHref = (id) => `#/r/${encodeURIComponent(id)}`;
const profileHref = (id) => `#/p/${encodeURIComponent(id)}`;

let current = null; // what's on screen: { kind, id, record }
let lastScreen = '';

async function render() {
  const r = route();
  if (r.kind === 'report') await renderReport(r.id);
  else if (r.kind === 'issues') await renderIssues();
  else if (r.kind === 'settings') await renderSettings();
  else if (r.kind === 'profile') await renderProfile(r.id);
  else if (r.kind === 'search') await renderSearch(r.id);
  else await renderFolder(r.id);
  // Start at the top when moving to a different screen, but not when refreshing the same one.
  const screen = `${r.kind}:${r.id}`;
  if (screen !== lastScreen) $('main').scrollTo(0, 0);
  lastScreen = screen;
}

function setHeader({ title, subtitle = '', crumbs = [], back = false, more = false, settings = false, search = false }) {
  $('#settings-btn').hidden = !settings;
  $('#search-btn').hidden = !search;
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
    search: true,
  });
  $('#fab-label').textContent = 'New';

  const [folders, reports] = await Promise.all([db.listChildren(id), here ? db.listReports(id) : []]);
  $('#folder-list').replaceChildren(...folders.map(folderRow));
  renderReportGroups(id, reports);
  $('#folder-empty').hidden = folders.length + reports.length > 0;
  $('#folder-empty').innerHTML = here
    ? 'Nothing here yet. Tap <strong>New</strong> to add a wet check report or a folder.'
    : 'No properties yet. Tap <strong>New</strong> to add a folder for one.';
  await renderBackupCard(!here);
  renderPropertyPhoto(path.length === 1 ? here : null);
  renderProfileCard(path.length === 1 ? here : null);
  $('#app-version').hidden = !!here;
  $('#app-version').textContent = `App version ${APP_VERSION}`;
  showView('folder');
}

// Reports without a subdivision come first under "Wet check reports"; each subdivision gets
// its own section after them (A to Z), which can be folded away. Subdivision names match
// regardless of capitals and spaces.
const subKey = (name) => (name || '').trim().replace(/\s+/g, ' ').toLowerCase();

function subdivisionGroups(reports) {
  const groups = new Map();
  for (const r of reports) {
    const key = subKey(r.subdivision);
    if (!key) continue;
    const name = r.subdivision.trim().replace(/\s+/g, ' ');
    if (!groups.has(key)) groups.set(key, { key, name, reports: [] });
    const g = groups.get(key);
    if (g.name === g.name.toLowerCase() && name !== name.toLowerCase()) g.name = name; // show a capitalized spelling if any
    g.reports.push(r);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

const FOLDED_KEY = 'foldedSubdivisions';
function foldedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function setFolded(id, folded) {
  const set = foldedSet();
  if (folded) set.add(id);
  else set.delete(id);
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...set]));
  } catch {}
}

function renderReportGroups(folderId, reports) {
  const out = [];
  const loose = reports.filter((r) => !subKey(r.subdivision));
  const groups = subdivisionGroups(reports);
  if (loose.length) {
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = 'Wet check reports';
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...loose.map((r) => reportRow(r)));
    out.push(h, ul);
  }
  const folded = foldedSet();
  for (const g of groups) {
    const foldId = `${folderId}|${g.key}`;
    const box = document.createElement('details');
    box.className = 'subdivision-group';
    box.open = !folded.has(foldId);
    const summary = document.createElement('summary');
    summary.className = 'section-title';
    const name = document.createElement('span');
    name.className = 'subdivision-name';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'subdivision-count';
    count.textContent = `${g.reports.length} report${g.reports.length === 1 ? '' : 's'}`;
    summary.append(name, count);
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.reports.map((r) => reportRow(r, true)));
    box.append(summary, ul);
    box.addEventListener('toggle', () => setFolded(foldId, !box.open));
    out.push(box);
  }
  $('#report-groups').replaceChildren(...out);
}

// ---------- Search ----------
// Finds properties and folders (and a property's contact), subdivisions, reports, and findings
// (issue, zone, note, city). Every word typed must match somewhere in the item.

let searchQuery = '';
let searchFrom = ''; // the folder search was opened from, to switch back from Everywhere
let focusFinding = null; // a finding to scroll to when its report opens from search
let searchData = null;
let searchTimer = 0;

const norm = (t) => String(t || '').toLowerCase();
const words = (q) => norm(q).split(/\s+/).filter(Boolean);
const matches = (hay, ws) => ws.every((w) => hay.includes(w));

async function renderSearch(scopeId) {
  const scope = scopeId ? await db.getFolder(scopeId) : null;
  if (scopeId && !scope) return (location.hash = '#/search');
  current = { kind: 'search', id: scopeId, record: scope };
  setHeader({ title: 'Search', back: true });
  const { folders, reports, findings } = await db.dumpAll();
  searchData = { folders, reports, findings, scope };
  if (scope) searchFrom = scope.id;
  const from = searchFrom ? scope || (await db.getFolder(searchFrom)) : null;
  const here = $('#search-scope-here');
  $('#search-scope').hidden = !from;
  here.textContent = from ? `In ${from.name}` : '';
  here.classList.toggle('on', !!scope);
  $('#search-scope-all').classList.toggle('on', !scope);
  const input = $('#search-input');
  input.value = searchQuery;
  showView('search');
  runSearch();
  if (!searchQuery) input.focus();
}

$('#search-input').addEventListener('input', () => {
  searchQuery = $('#search-input').value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#search-input').blur(); // hide the keyboard to see the results
});
$('#search-scope-all').addEventListener('click', () => current.id && location.replace('#/search'));
$('#search-scope-here').addEventListener('click', () => !current.id && searchFrom && location.replace(`#/search/${encodeURIComponent(searchFrom)}`));

// Wraps each typed word found in el's text in <mark>.
function markWords(el, ws) {
  if (!el || !ws.length) return;
  const text = el.textContent;
  const lower = text.toLowerCase();
  const hits = [];
  for (const w of ws) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) hits.push([i, i + w.length]);
  if (!hits.length) return;
  hits.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a < at) continue;
    if (a > at) parts.push(text.slice(at, a));
    const m = document.createElement('mark');
    m.textContent = text.slice(a, b);
    parts.push(m);
    at = b;
  }
  parts.push(text.slice(at));
  el.replaceChildren(...parts);
}

function resultRow(opts, ws) {
  const li = row(opts);
  markWords(li.querySelector('.row-name'), ws);
  markWords(li.querySelector('.row-detail'), ws);
  return li;
}

const SEARCH_LIMIT = 50;

function runSearch() {
  if (!searchData) return;
  const ws = words(searchQuery);
  const out = [];
  const empty = $('#search-empty');
  if (!ws.length) {
    $('#search-results').replaceChildren();
    empty.hidden = false;
    empty.textContent = 'Search by property, folder, subdivision, report name or date, issue, zone, or note.';
    return;
  }
  const { folders, reports, findings, scope } = searchData;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id) => {
    const names = [];
    for (let f = byId.get(id), n = 0; f && n < 50; f = byId.get(f.parentId), n++) names.unshift(f.name);
    return names;
  };
  const inScope = (folderId) => {
    if (!scope) return true;
    for (let f = byId.get(folderId), n = 0; f && n < 50; f = byId.get(f.parentId), n++) if (f.id === scope.id) return true;
    return false;
  };
  const where = (folderId) => pathOf(folderId).join(' › ');
  const section = (title, rows) => {
    if (!rows.length) return;
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = rows.length > SEARCH_LIMIT ? `${title} · first ${SEARCH_LIMIT} of ${rows.length}` : `${title} · ${rows.length}`;
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...rows.slice(0, SEARCH_LIMIT).map((make) => make()));
    out.push(h, ul);
  };

  // Folders
  const folderHits = folders
    .filter((f) => f.id !== scope?.id && inScope(f.id))
    .filter((f) => {
      const c = f.profile?.contact || {};
      return matches(norm([f.name, c.name, c.address, c.email, c.phone].join(' ')), ws);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((f) => () =>
      resultRow({ icon: FOLDER_ICON, name: f.name, detail: f.parentId === db.ROOT ? 'Property' : where(f.parentId), href: folderHref(f.id) }, ws)
    );
  section('Properties and folders', folderHits);

  // Subdivisions, one per folder they're used in
  const scoped = reports.filter((r) => inScope(r.folderId));
  const subHits = [];
  const byFolder = new Map();
  for (const r of scoped) if (subKey(r.subdivision)) (byFolder.get(r.folderId) || byFolder.set(r.folderId, []).get(r.folderId)).push(r);
  for (const [folderId, rs] of byFolder) {
    for (const g of subdivisionGroups(rs)) {
      if (!matches(g.key, ws)) continue;
      subHits.push({ g, folderId });
    }
  }
  subHits.sort((a, b) => a.g.name.localeCompare(b.g.name, undefined, { numeric: true }));
  section(
    'Subdivisions',
    subHits.map(({ g, folderId }) => () => {
      const li = resultRow({ icon: FOLDER_ICON, name: g.name, detail: `${where(folderId)} · ${plural(g.reports.length, 'report')}`, href: folderHref(folderId) }, ws);
      li.querySelector('a').addEventListener('click', () => setFolded(`${folderId}|${g.key}`, false));
      return li;
    })
  );

  // Reports
  const reportHits = scoped
    .filter((r) => matches(norm([r.name, r.subdivision, r.date, formatDate(r.date)].join(' ')), ws))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => () =>
      resultRow({ icon: REPORT_ICON, name: r.name, detail: [where(r.folderId), r.subdivision, formatDate(r.date)].filter(Boolean).join(' · '), href: reportHref(r.id) }, ws)
    );
  section('Reports', reportHits);

  // Findings
  const reportById = new Map(scoped.map((r) => [r.id, r]));
  const findingHits = findings
    .filter((f) => reportById.has(f.reportId))
    .filter((f) => matches(norm([f.issue, f.zone ? `zone ${f.zone}` : '', f.note, f.stamp?.city].join(' ')), ws))
    .sort((a, b) => reportById.get(b.reportId).date.localeCompare(reportById.get(a.reportId).date) || (a.createdAt || 0) - (b.createdAt || 0))
    .map((f) => () => {
      const r = reportById.get(f.reportId);
      const detail = [pathOf(r.folderId)[0], r.name, f.zone ? zoneName(f.zone) : '', f.note].filter(Boolean).join(' · ');
      const li = resultRow({ icon: REPORT_ICON, name: f.issue || 'Finding', detail, href: reportHref(r.id) }, ws);
      const a = li.querySelector('a');
      if (f.photo instanceof Blob) {
        const img = document.createElement('img');
        img.className = 'result-photo';
        img.alt = '';
        const url = URL.createObjectURL(f.photo);
        img.onload = img.onerror = () => URL.revokeObjectURL(url);
        img.src = url;
        a.querySelector('svg').replaceWith(img);
      }
      a.addEventListener('click', () => (focusFinding = f.id));
      return li;
    });
  section('Findings', findingHits);

  $('#search-results').replaceChildren(...out);
  empty.hidden = out.length > 0;
  empty.textContent = scope ? `Nothing in ${scope.name} matches “${searchQuery.trim()}”. Try Everywhere.` : `Nothing matches “${searchQuery.trim()}”.`;
}

// ---------- Company logo (home screen) ----------

let companyLogoUrl = null;

// ---------- Settings screen ----------

async function renderSettings() {
  current = { kind: 'settings', id: '', record: null };
  setHeader({ title: 'Settings', back: true });
  await Promise.all([renderCompanyCard(), renderIssuesCard(), renderDisclaimerCard(), renderSignatureCard(), renderBackupCard(false)]);
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
  li.append(a);
  if (onMenu) {
    const more = document.createElement('button');
    more.className = 'row-more';
    more.setAttribute('aria-label', menuLabel);
    more.innerHTML = MORE_ICON;
    more.addEventListener('click', onMenu);
    li.append(more);
  }
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

function reportRow(report, grouped = false) {
  return row({
    icon: REPORT_ICON,
    name: report.name,
    detail: grouped ? formatDate(report.date) : reportDetail(report),
    href: reportHref(report.id),
    menuLabel: `Options for ${report.name}`,
    onMenu: () => reportMenu(report),
  });
}

async function folderMenu(folder) {
  const top = folder.parentId === db.ROOT;
  const action = await askAction(folder.name, [
    ...(top ? [{ label: 'Property profile', value: 'profile' }] : []),
    { label: 'Rename', value: 'rename' },
    { label: 'Back up or share this property', value: 'backup' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'profile') location.hash = profileHref(folder.id);
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
    ...(report.estimate ? [{ label: 'Use current prices', value: 'prices' }] : []),
    { label: 'Edit report details', value: 'edit' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
  if (action === 'estimate') {
    await db.updateReport(report.id, { estimate: !report.estimate });
    render();
  }
  if (action === 'prices') await refreshPrices(report);
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
    const details = await askReportDetails('New wet check report', 'Create', { name: 'Wet check', date: today(), estimate }, folderId);
    if (!details) return;
    await db.setSetting('estimateDefault', details.estimate);
    const prices = priceSnapshot(await issueListFor(folderId)); // locked in for this report
    const report = await db.createReport(folderId, details.name, details.date, { estimate: details.estimate, subdivision: details.subdivision, prices });
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
  const list = report.estimate ? await issueListFor(report.folderId) : null;
  renderEstimateBar(report, findings, list);

  const sections = groupByZone(findings).map(([z, items]) => {
    const section = document.createElement('section');
    section.className = 'zone-group' + (z === zone ? ' current' : '');
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = `${zoneName(z)} · ${plural(items.length, 'finding')}`;
    const ul = document.createElement('ul');
    ul.className = 'cards';
    ul.append(...items.map((f, i) => findingCard(f, i + 1, list, report.prices)));
    section.append(h, ul);
    return section;
  });
  $('#finding-groups').replaceChildren(...sections);
  $('#report-empty').hidden = findings.length > 0;
  showView('report');
  if (focusFinding) {
    const card = $('#finding-groups').querySelector(`li[data-id="${CSS.escape(focusFinding)}"]`);
    focusFinding = null;
    if (card) {
      requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 2000);
    }
  }
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

function findingCard(finding, number, list = null, snapshot = null) {
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
    img.className = finding.mark ? 'card-photo mark' : 'card-photo';
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
  if (list && finding.mark !== 'ok') {
    const price = findingPrice(finding, list, snapshot);
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
    // Android's Chrome only shares some file types (PDFs and photos, not .zip backups), so
    // Download is always offered too, and a share that fails falls back to downloading.
    let canShare = false;
    try {
      canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch {
      canShare = false;
    }
    share.hidden = !canShare;
    download.hidden = false;
    download.classList.toggle('primary', !canShare);
    download.classList.toggle('outline', canShare);
    download.textContent = canShare ? 'Save' : 'Download';
    open.hidden = !canOpen;
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (!canShare && isAndroid) {
      $('#pdf-text').textContent += ' This phone can’t share this kind of file directly: tap Download, then share it from the Files app (Downloads).';
    }
    share.onclick = async () => {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (err) {
        if (err && err.name === 'AbortError') return; // share sheet dismissed
        download.click();
        $('#pdf-text').textContent = `Sharing didn’t open on this phone, so ${name} was downloaded instead. You can share it from the Files app (Downloads).`;
      }
    };
  } catch (err) {
    $('#pdf-title').textContent = failed;
    $('#pdf-text').textContent = err && err.message ? err.message : 'Something went wrong. Try again.';
  }
  await closed;
}

// The report's PDF: { blob, name }. Used by Export PDF and by backups.
async function reportPdf(report) {
  const [path, findings, logo, companyName, accent, list] = await Promise.all([
    db.getPath(report.folderId),
    db.listFindings(report.id),
    db.getSetting('companyLogo'),
    db.getSetting('companyName'),
    db.getSetting('accentColor'),
    issueListFor(report.folderId),
  ]);
  const property = path.map((f) => f.name);
  const estimate = report.estimate ? buildEstimate(findings, list, report.prices) : null;
  const profile = path.length ? path[0].profile : null;
  const blob = await buildReportPdf({
    estimate,
    report,
    property,
    propertyPhoto: path.length ? path[0].photo || null : null, // set on the top-level property folder
    logo,
    companyName,
    accent: accent || DEFAULT_ACCENT,
    contact: profile && profile.contact ? profile.contact : null,
    signature: await signatureFor(report),
    groups: groupByZone(findings),
    zoneName,
  });
  return { blob, name: pdfFileName(property, report) };
}

// Before exporting, the report is signed: it starts from the default signature in Settings
// (or what was used last time for this report) and can be changed for this report only.
async function exportPdf(report) {
  const def = await defaultSignature();
  const saved = report.signature;
  if (def.on || saved) {
    const start = saved
      ? { on: !saved.off, image: report.signatureImage || null, name: saved.name || '', role: saved.role || '', date: saved.date || today() }
      : { on: true, image: def.image, name: def.name, role: def.role, date: today() };
    const r = await askSignature({ mode: 'report', ...start, defaults: def });
    if (!r) return;
    report = await db.updateReport(report.id, {
      signature: { off: !r.on, name: r.name, role: r.role, date: r.date },
      signatureImage: r.on ? r.image : null,
    });
    if (current.kind === 'report' && current.id === report.id) current.record = report;
  }
  return deliverFile({
    working: 'Making PDF…',
    workingText: 'This takes a few seconds for reports with lots of photos.',
    ready: 'PDF ready',
    failed: 'Couldn’t make the PDF',
    canOpen: true,
    build: () => reportPdf(report),
  });
}

// ---------- Signature ----------
// Settings hold the default: 'signatureImage' (PNG Blob), 'signatureName', 'signatureRole',
// 'signatureEnabled'. A report keeps what it was signed with: report.signature
// { off, name, role, date } and report.signatureImage (kept top-level so db.put copies the Blob).

async function defaultSignature() {
  const [image, name, role, on] = await Promise.all(['signatureImage', 'signatureName', 'signatureRole', 'signatureEnabled'].map((k) => db.getSetting(k)));
  return { on: !!on, image: image instanceof Blob ? image : null, name: name || '', role: role || '' };
}

async function signatureFor(report) {
  if (report.signature) {
    const s = report.signature;
    return s.off || (!report.signatureImage && !s.name) ? null : { image: report.signatureImage || null, name: s.name, role: s.role, date: s.date || report.date };
  }
  const def = await defaultSignature();
  return def.on && (def.image || def.name) ? { image: def.image, name: def.name, role: def.role, date: report.date } : null;
}

let signatureUrl = null;
function showSignatureImage(img, empty, blob) {
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  delete img.dataset.url;
  img.hidden = !blob;
  if (blob) {
    img.dataset.url = URL.createObjectURL(blob);
    img.src = img.dataset.url;
  } else img.removeAttribute('src');
  if (empty) empty.hidden = !!blob;
}

// mode 'settings' edits the default; mode 'report' signs one report before export.
// Resolves with { on, image, name, role, date } or null if cancelled.
async function askSignature({ mode, on, image, name, role, date = today(), defaults = null }) {
  const forReport = mode === 'report';
  $('#signature-title').textContent = forReport ? 'Sign this report' : 'Technician signature';
  $('#signature-hint').textContent = forReport
    ? 'Changes here apply to this report only. Your default signature is set in Settings.'
    : 'Your default signature. Before each export you can sign again or change it for that report.';
  $('#signature-enabled-label').textContent = forReport ? 'Include a signature on this report' : 'Sign reports when exporting';
  $('#signature-submit').textContent = forReport ? 'Export PDF' : 'Save';
  $('#signature-date-box').hidden = !forReport;
  const hasDefault = !!(defaults && (defaults.image || defaults.name));
  $('#signature-default').hidden = !forReport || !hasDefault;

  const box = $('#signature-enabled');
  const show = () => {
    showSignatureImage($('#signature-img'), $('#signature-empty'), image);
    $('#signature-clear').disabled = !image;
    $('#signature-sign').textContent = image ? 'Re-sign' : 'Sign';
  };
  const showFields = () => ($('#signature-fields').hidden = !box.checked);
  box.checked = on;
  box.onchange = showFields;
  $('#signature-name').value = name;
  $('#signature-role').value = role;
  $('#signature-date').value = date;
  const sign = async () => {
    const drawn = await drawSignature({ name: $('#signature-name').value.trim() });
    if (drawn === undefined) return;
    image = drawn;
    show();
  };
  $('#signature-preview').onclick = sign;
  $('#signature-sign').onclick = sign;
  $('#signature-clear').onclick = () => {
    image = null;
    show();
  };
  $('#signature-default').onclick = () => {
    image = defaults.image;
    $('#signature-name').value = defaults.name;
    $('#signature-role').value = defaults.role;
    box.checked = true;
    showFields();
    show();
  };
  show();
  showFields();
  const result = await showDialog($('#signature-dialog'));
  showSignatureImage($('#signature-img'), null, null);
  if (result !== 'ok') return null;
  return {
    on: box.checked,
    image,
    name: $('#signature-name').value.trim(),
    role: $('#signature-role').value.trim(),
    date: $('#signature-date').value || today(),
  };
}

async function renderSignatureCard() {
  const def = await defaultSignature();
  const set = def.image || def.name;
  $('#settings-signature-name').textContent = `Technician signature: ${def.on ? 'on' : 'off'}`;
  $('#settings-signature-detail').textContent = !set
    ? 'Set up the signature for your exported reports.'
    : [def.name, def.role].filter(Boolean).join(', ') || 'Signature saved';
  if (signatureUrl) URL.revokeObjectURL(signatureUrl);
  signatureUrl = def.image ? URL.createObjectURL(def.image) : null;
  const img = $('#settings-signature-img');
  img.hidden = !def.image;
  if (def.image) img.src = signatureUrl;
  else img.removeAttribute('src');
}

$('#settings-signature').addEventListener('click', async () => {
  const def = await defaultSignature();
  const first = !def.image && !def.name;
  const r = await askSignature({ mode: 'settings', on: first ? true : def.on, image: def.image, name: def.name, role: def.role });
  if (!r) return;
  await Promise.all([
    db.setSetting('signatureEnabled', r.on),
    db.setSetting('signatureImage', r.image),
    db.setSetting('signatureName', r.name),
    db.setSetting('signatureRole', r.role),
  ]);
  renderSignatureCard();
  showToast('Signature saved.', 'ok');
});

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
    workingText: 'Packing up your reports, PDFs and photos.',
    ready: 'Backup ready',
    failed: 'Couldn’t make the backup',
    build: async () => {
      const { blob, name, counts, pdfsFailed } = await createBackup(APP_VERSION, folder ? folder.id : null, {
        makePdf: reportPdf,
        issueList: await loadIssueList(),
        progress: (text) => ($('#pdf-text').textContent = `Packing up your reports, PDFs and photos. ${text}`),
      });
      const missing = pdfsFailed ? ` ${plural(pdfsFailed, 'PDF')} couldn’t be made and ${pdfsFailed === 1 ? 'was' : 'were'} left out.` : '';
      return { blob, name, detail: `Includes ${countsText(counts)}.${missing} Save it somewhere safe, like Files, iCloud Drive or Google Drive. Open it there to see it as a folder.` };
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
  await lockMissingPrices();
  location.hash = '#/';
  await render();
  showToast(`Restored ${countsText(backup.counts)}.`, 'ok');
});

async function askReportDetails(title, submitLabel, initial, folderId) {
  // Offer the subdivisions already used in this folder, so the same name groups together.
  const used = subdivisionGroups(await db.listReports(folderId)).map((g) => {
    const o = document.createElement('option');
    o.value = g.name;
    return o;
  });
  $('#subdivision-options').replaceChildren(...used);
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
  const details = await askReportDetails('Edit report', 'Save', report, report.folderId);
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
  const est = buildEstimate(findings, list, report.prices);
  $('#estimate-total').textContent = formatMoney(est.total);
  const detail = $('#estimate-detail');
  detail.classList.toggle('warn', est.unpriced > 0);
  if (!findings.length) detail.textContent = 'Findings are priced from your price list as you add them.';
  else if (est.unpriced) detail.textContent = `${plural(est.unpriced, 'finding')} without a price, not included. Tap to see the estimate.`;
  else detail.textContent = `${plural(findings.length, 'finding')} priced. Tap to see the estimate.`;
}

async function showEstimate(report) {
  const [findings, list] = await Promise.all([db.listFindings(report.id), issueListFor(report.folderId)]);
  const est = buildEstimate(findings, list, report.prices);
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
  warn.textContent = `${plural(est.unpriced, 'finding')} without a price ${est.unpriced === 1 ? 'isn’t' : 'aren’t'} included. Set prices in Settings or the property profile, or type a price on the finding.`;
  $('#estimate-refresh').onclick = async () => {
    $('#estimate-dialog').close('cancel');
    await refreshPrices(report);
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
// Resolves with { name, price }, 'delete', 'reset', or null.
// opts: list (for duplicate names), nameLocked, canDelete, canReset, mainHint, renameHint.
async function askIssue(title, issue, opts = {}) {
  const { list = issueList, nameLocked = false, canDelete = !!issue, canReset = false, mainHint = '', renameHint = !!issue } = opts;
  $('#issue-dialog-title').textContent = title;
  $('#issue-name').value = issue ? issue.name : '';
  $('#issue-name').readOnly = nameLocked;
  $('#issue-price').value = issue && issue.price != null ? issue.price.toFixed(2) : '';
  $('#issue-delete').hidden = !canDelete;
  $('#issue-reset').hidden = !canReset;
  $('#issue-rename-hint').hidden = !renameHint;
  $('#issue-main-hint').hidden = !mainHint;
  $('#issue-main-hint').textContent = mainHint;
  const err = $('#issue-error');
  err.hidden = true;
  $('#issue-delete').onclick = () => $('#issue-dialog').close('delete');
  $('#issue-reset').onclick = () => $('#issue-dialog').close('reset');
  for (;;) {
    const result = await showDialog($('#issue-dialog'));
    if (result === 'delete' || result === 'reset') return result;
    if (result !== 'ok') return null;
    const name = $('#issue-name').value.trim();
    const rawPrice = $('#issue-price').value.trim();
    const price = toPrice(rawPrice);
    const taken = findIssue(list, name);
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

// ---------- Property profiles ----------

// The top-level property a folder belongs to (where its profile lives).
async function propertyFolder(folderId) {
  const path = await db.getPath(folderId);
  return path[0] || null;
}

// The issue list for a folder: the main list with its property's changes applied.
async function issueListFor(folderId) {
  const [list, property] = await Promise.all([loadIssueList(), propertyFolder(folderId)]);
  return effectiveList(list, property && property.profile);
}

async function disclaimerFor(property) {
  if (property && property.profile && property.profile.disclaimer) return property.profile.disclaimer;
  return mainDisclaimer();
}

const mainDisclaimer = async () => (await db.getSetting('disclaimer')) || DEFAULT_DISCLAIMER;
// The disclaimer checkbox on findings can be turned off in Settings, and per property.
const mainDisclaimerOn = async () => (await db.getSetting('disclaimerEnabled')) !== false;
async function disclaimerOnFor(property) {
  const own = property && property.profile ? property.profile.disclaimerOn : null;
  return own != null ? own : mainDisclaimerOn();
}

// The disclaimer dialog with its on/off switch. Resolves with { on, text } or null.
async function askDisclaimer({ title, hint, on, onLabel, text, resetTo }) {
  const input = $('#disclaimer-input');
  const box = $('#disclaimer-enabled');
  $('#disclaimer-dialog h2').textContent = title;
  $('#disclaimer-dialog .hint').textContent = hint;
  $('#disclaimer-enabled-box').hidden = false;
  $('#disclaimer-enabled-label').textContent = onLabel;
  box.checked = on;
  input.value = text;
  $('#disclaimer-reset').onclick = () => (input.value = resetTo);
  const result = await showDialog($('#disclaimer-dialog'));
  $('#disclaimer-dialog h2').textContent = 'Troubleshooting disclaimer';
  $('#disclaimer-dialog .hint').textContent = DISCLAIMER_HINT;
  $('#disclaimer-enabled-box').hidden = true;
  if (result !== 'ok') return null;
  return { on: box.checked, text: input.value.trim() };
}

async function renderDisclaimerCard() {
  const [on, text] = await Promise.all([mainDisclaimerOn(), mainDisclaimer()]);
  $('#settings-disclaimer-name').textContent = `Troubleshooting disclaimer: ${on ? 'on' : 'off'}`;
  $('#settings-disclaimer-detail').textContent = on ? text : 'Not offered on findings. Tap to turn it on or edit it.';
}

$('#settings-disclaimer').addEventListener('click', async () => {
  const r = await askDisclaimer({
    title: 'Troubleshooting disclaimer',
    hint: 'When on, each finding has a checkbox to add this disclaimer. Properties can change it in their profile. Findings that already have a disclaimer keep it.',
    on: await mainDisclaimerOn(),
    onLabel: 'Offer the disclaimer on findings',
    text: await mainDisclaimer(),
    resetTo: DEFAULT_DISCLAIMER,
  });
  if (!r) return;
  await db.setSetting('disclaimerEnabled', r.on);
  if (r.text) await db.setSetting('disclaimer', r.text);
  render();
});

// Merges changes into a property's profile; drops it entirely once nothing is left in it.
async function saveProfile(folderId, changes) {
  const folder = await db.getFolder(folderId);
  const profile = { issues: {}, added: [], disclaimer: null, disclaimerOn: null, contact: null, ...(folder.profile || {}), ...changes };
  const empty = !Object.keys(profile.issues).length && !profile.added.length && !profile.disclaimer && profile.disclaimerOn == null && !profile.contact;
  return db.updateFolder(folderId, { profile: empty ? null : profile });
}

// Reports keep the prices from the day they were made; this brings one up to today's.
async function refreshPrices(report) {
  const ok = await askConfirm(
    'Use current prices',
    `Update “${report.name}” to today’s prices for this property? Prices typed on individual findings stay as they are.`,
    'Update'
  );
  if (!ok) return;
  await db.updateReport(report.id, { prices: priceSnapshot(await issueListFor(report.folderId)) });
  render();
}

// Reports made before prices were locked in (or restored from an older backup) get
// today's prices once, so later price changes don't move them.
async function lockMissingPrices() {
  const reports = (await db.getAllReports()).filter((r) => !r.prices);
  for (const r of reports) await db.updateReport(r.id, { prices: priceSnapshot(await issueListFor(r.folderId)) });
}

function renderProfileCard(property) {
  const card = $('#profile-card');
  card.hidden = !property;
  if (!property) return;
  const p = property.profile || {};
  const parts = [];
  if (p.contact && p.contact.name) parts.push(`Contact: ${p.contact.name}`);
  const custom = Object.keys(p.issues || {}).length + (p.added || []).length;
  if (custom) parts.push(`${plural(custom, 'custom issue')}`);
  if (p.disclaimerOn === false) parts.push('disclaimer off');
  else if (p.disclaimer || p.disclaimerOn === true) parts.push('own disclaimer');
  $('#profile-card-detail').textContent = parts.length ? parts.join(' · ') : 'Contact, disclaimer, and issues and prices for this property.';
}

$('#profile-card').addEventListener('click', () => (location.hash = profileHref(current.id)));

let profileList = null; // effective list on the profile screen

async function renderProfile(id) {
  const folder = await db.getFolder(id);
  if (!folder) return (location.hash = '#/');
  current = { kind: 'profile', id, record: folder };
  setHeader({ title: 'Property profile', subtitle: folder.name, back: true });
  const p = folder.profile || {};

  const c = p.contact;
  $('#profile-contact-name').textContent = c && c.name ? c.name : c ? 'Property contact' : 'Add a property contact';
  $('#profile-contact-detail').textContent = c
    ? [c.phone, c.email, c.address].filter(Boolean).join(' · ') || 'Tap to edit.'
    : 'Shown on the cover of this property’s reports.';

  const [mainText, mainOn] = await Promise.all([mainDisclaimer(), mainDisclaimerOn()]);
  const on = p.disclaimerOn != null ? p.disclaimerOn : mainOn;
  $('#profile-disclaimer-name').textContent = !on
    ? `Off for this property${p.disclaimerOn == null ? ' (off in Settings)' : ''}`
    : p.disclaimer ? 'Custom disclaimer for this property' : 'Using the main disclaimer';
  $('#profile-disclaimer-text').textContent = on ? p.disclaimer || mainText : 'Findings here won’t offer the disclaimer. Tap to change.';

  profileList = effectiveList(await loadIssueList(), p);
  $('#profile-issue-groups').replaceChildren(...profileList.groups.map((g) => {
    const section = document.createElement('section');
    const h = document.createElement('h2');
    h.className = 'section-title';
    h.textContent = g.name || 'Issues';
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...g.issues.map((issue) => profileIssueRow(g, issue)));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn small outline add-issue';
    add.textContent = '+ Add issue for this property';
    add.addEventListener('click', () => addProfileIssue(g));
    section.append(h, ul, add);
    return section;
  }));
  showView('profile');
}

function profileIssueRow(group, issue) {
  const li = document.createElement('li');
  li.className = 'issue-row' + (issue.off ? ' off' : '');
  const toggle = document.createElement('label');
  toggle.className = 'issue-toggle';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !issue.off;
  box.setAttribute('aria-label', `Use ${issue.name} at this property`);
  box.addEventListener('change', () => setProfileIssue(issue, { off: !box.checked }));
  toggle.append(box);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'issue-main';
  const name = document.createElement('span');
  name.className = 'issue-name';
  name.textContent = issue.name;
  main.append(name);
  if (issue.custom || issue.own) {
    const tag = document.createElement('span');
    tag.className = 'issue-tag' + (issue.own ? ' own' : '');
    tag.textContent = issue.own ? 'This property' : 'Custom';
    main.append(tag);
  }
  const price = document.createElement('span');
  price.className = 'issue-price' + (issue.price == null ? ' none' : '');
  price.textContent = issue.price == null ? 'No price' : formatMoney(issue.price);
  main.append(price);
  main.addEventListener('click', () => editProfileIssue(group, issue));
  li.append(toggle, main);
  return li;
}

// Records a change to one issue for this property. A main-list issue whose values end up
// matching the main list again stops being custom.
async function setProfileIssue(issue, changes) {
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  if (issue.own) {
    const added = (p.added || []).map((a) => (a.name === issue.name ? { ...a, ...changes } : a));
    await saveProfile(current.id, { added });
  } else {
    const issues = { ...(p.issues || {}) };
    const o = { ...(issues[issue.name] || {}), ...changes };
    const main = findIssue(await loadIssueList(), issue.name);
    if ('price' in o && main && o.price === main.price) delete o.price;
    if ('off' in o && main && o.off === !!main.off) delete o.off;
    if (Object.keys(o).length) issues[issue.name] = o;
    else delete issues[issue.name];
    await saveProfile(current.id, { issues });
  }
  render();
}

async function editProfileIssue(group, issue) {
  const mainHint = issue.own
    ? 'Only used at this property.'
    : `Main list price: ${issue.custom ? (issue.mainPrice == null ? 'no price' : formatMoney(issue.mainPrice)) : issue.price == null ? 'no price' : formatMoney(issue.price)}. To rename this issue, use Settings.`;
  const r = await askIssue(issue.name, issue, {
    list: profileList,
    nameLocked: !issue.own,
    canDelete: !!issue.own,
    canReset: !!issue.custom,
    mainHint,
    renameHint: false,
  });
  if (!r) return;
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  if (r === 'reset') {
    const issues = { ...(p.issues || {}) };
    delete issues[issue.name];
    await saveProfile(current.id, { issues });
    return render();
  }
  if (r === 'delete') {
    if (!(await askConfirm('Delete issue', `Remove “${issue.name}” from this property? Findings already saved with it keep it.`))) return;
    await saveProfile(current.id, { added: (p.added || []).filter((a) => a.name !== issue.name) });
    return render();
  }
  if (issue.own) {
    const added = (p.added || []).map((a) => (a.name === issue.name ? { ...a, name: r.name, price: r.price } : a));
    await saveProfile(current.id, { added });
    return render();
  }
  await setProfileIssue(issue, { price: r.price });
}

async function addProfileIssue(group) {
  const r = await askIssue(`Add to ${group.name || 'the list'} for this property`, null, { list: profileList, canDelete: false, renameHint: false, mainHint: 'Only used at this property.' });
  if (!r || typeof r === 'string') return;
  const folder = await db.getFolder(current.id);
  const p = folder.profile || {};
  await saveProfile(current.id, { added: [...(p.added || []), { group: group.name, name: r.name, price: r.price, off: false }] });
  render();
}

$('#profile-contact').addEventListener('click', async () => {
  const c = (current.record.profile && current.record.profile.contact) || {};
  $('#contact-name').value = c.name || '';
  $('#contact-phone').value = c.phone || '';
  $('#contact-email').value = c.email || '';
  $('#contact-address').value = c.address || '';
  if ((await showDialog($('#contact-dialog'))) !== 'ok') return;
  const contact = {
    name: $('#contact-name').value.trim(),
    phone: $('#contact-phone').value.trim(),
    email: $('#contact-email').value.trim(),
    address: $('#contact-address').value.trim(),
  };
  await saveProfile(current.id, { contact: Object.values(contact).some(Boolean) ? contact : null });
  render();
});

$('#profile-disclaimer').addEventListener('click', async () => {
  const p = current.record.profile || {};
  const [main, mainOn] = await Promise.all([mainDisclaimer(), mainDisclaimerOn()]);
  const r = await askDisclaimer({
    title: 'Disclaimer for this property',
    hint: 'Used on this property’s findings instead of the main disclaimer. Reset goes back to the main wording.',
    on: p.disclaimerOn != null ? p.disclaimerOn : mainOn,
    onLabel: 'Offer the disclaimer at this property',
    text: p.disclaimer || main,
    resetTo: main,
  });
  if (!r) return;
  // Only what differs from Settings is kept, so the rest keeps following it.
  await saveProfile(current.id, {
    disclaimer: r.text && r.text !== main ? r.text : null,
    disclaimerOn: r.on === mainOn ? null : r.on,
  });
  render();
});

$('#reset-profile').addEventListener('click', async () => {
  const ok = await askConfirm(
    'Reset property',
    `Remove the contact, disclaimer and all custom issues and prices for “${current.record.name}”? It will use the main settings again. Existing reports keep their prices.`,
    'Reset'
  );
  if (!ok) return;
  await db.updateFolder(current.id, { profile: null });
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
  // A property with its own disclaimer keeps edits there; otherwise it's the main one.
  if (form.property && form.property.profile && form.property.profile.disclaimer) await saveProfile(form.property.id, { disclaimer: text });
  else await db.setSetting('disclaimer', text);
  setDisclaimer(text, true); // editing it implies wanting it on this finding
});

async function fillIssues(selected) {
  const list = (form.list = await issueListFor(current.record.folderId));
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
  const listPrice = form.issue.value ? findingPrice({ issue: form.issue.value }, form.list, current.record.prices) : null;
  form.price.placeholder = listPrice != null ? formatMoney(listPrice) : 'No price';
  if (!form.issue.value) form.priceHint.textContent = 'Choose an issue to fill in its price.';
  else if (listPrice != null) form.priceHint.textContent = `This report’s price: ${formatMoney(listPrice)}. Type a different price for just this finding.`;
  else form.priceHint.textContent = 'This issue has no price yet. Type one here, or set it in Settings or the property profile.';
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
  form.property = await propertyFolder(current.record.folderId);
  const saved = await disclaimerFor(form.property);
  setDisclaimer(finding && finding.disclaimer ? finding.disclaimer : saved, !!(finding && finding.disclaimer));
  // Hidden when turned off, unless this finding already has one (so it can still be removed).
  $('#disclaimer-box').hidden = !(await disclaimerOnFor(form.property)) && !(finding && finding.disclaimer);
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
  if (fields.price != null && fields.price === findingPrice({ issue: fields.issue }, form.list, current.record.prices)) fields.price = null;
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
    // A zone status mark stays one until its image is replaced with a photo.
    if (finding.mark && fields.photo === finding.photo) fields.mark = finding.mark;
    await db.saveFinding(finding.reportId, fields, finding.id);
    render();
  }
  if (result === 'delete') {
    if (!(await askConfirm('Delete finding', `Delete the “${finding.issue}” finding? This can’t be undone.`))) return;
    await db.deleteFinding(finding.id);
    render();
  }
}

// ---------- Zone status marks ----------
// One tap adds a finding for the current zone with a drawn image in place of a photo:
// a green check for "No issues found", or a red X that sets the issue to "Valve not opening"
// (priced from the list like any finding). finding.mark is 'ok' or 'fail'. Both open for
// editing like any other finding.

const MARKS = {
  ok: { color: '#1f9d55', issue: 'No issues found', toast: 'no issues found' },
  fail: { color: '#d32f2f', issue: 'Valve not opening', toast: 'valve not opening' },
};
const markImages = {};

function markImage(kind) {
  if (markImages[kind]) return markImages[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 600;
  const ctx = c.getContext('2d');
  const { color } = MARKS[kind];
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 20; // frame
  const r = 36, m = 16, w = 600 - m * 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(m, m, w, w, r) : ctx.rect(m, m, w, w);
  ctx.stroke();
  ctx.lineWidth = 68;
  ctx.beginPath();
  if (kind === 'ok') {
    ctx.moveTo(156, 312);
    ctx.lineTo(256, 412);
    ctx.lineTo(448, 204);
  } else {
    ctx.moveTo(184, 184);
    ctx.lineTo(416, 416);
    ctx.moveTo(416, 184);
    ctx.lineTo(184, 416);
  }
  ctx.stroke();
  markImages[kind] = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  return markImages[kind];
}

let marking = false;
async function addMark(kind) {
  if (marking || current.kind !== 'report') return;
  marking = true;
  $('#mark-ok').disabled = $('#mark-fail').disabled = true;
  try {
    const report = current.record;
    const zone = zoneOf(report);
    const pos = await getPosition(6000); // the spot is handy for a valve that won't open
    const fields = {
      photo: await markImage(kind),
      morePhotos: [],
      stamp: { takenAt: Date.now(), ...(pos || {}) },
      issue: MARKS[kind].issue,
      zone,
      note: '',
      disclaimer: '',
      price: null,
      mark: kind,
    };
    const saved = await db.saveFinding(report.id, fields);
    await render();
    const card = document.querySelector(`[data-id="${saved.id}"]`);
    if (card) card.scrollIntoView({ block: 'center' });
    showToast(`${zone ? zoneName(zone) : 'Zone'} marked: ${MARKS[kind].toast}. Tap it to edit.`, 'ok');
  } finally {
    marking = false;
    $('#mark-ok').disabled = $('#mark-fail').disabled = false;
  }
}

$('#mark-ok').addEventListener('click', () => addMark('ok'));
$('#mark-fail').addEventListener('click', () => addMark('fail'));

// ---------- Wiring ----------

function showView(kind) {
  $('#folder-view').hidden = kind !== 'folder';
  $('#report-view').hidden = kind !== 'report';
  $('#issues-view').hidden = kind !== 'issues';
  $('#settings-view').hidden = kind !== 'settings';
  $('#profile-view').hidden = kind !== 'profile';
  $('#search-view').hidden = kind !== 'search';
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
  // Anything opened from search goes back to the results.
  if (current.kind !== 'search' && (visited[visited.length - 2] || '').startsWith('#/search')) return history.back();
  // Search opens from any folder, so go back to where it was opened.
  if (current.kind === 'search') return visited.length > 1 ? history.back() : (location.hash = folderHref(current.id || db.ROOT));
  const parent = current.kind === 'profile'
    ? folderHref(current.id)
    : current.kind === 'issues'
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
$('#search-btn').addEventListener('click', () => {
  const here = current.kind === 'folder' && current.record ? current.record.id : '';
  searchQuery = '';
  searchFrom = here;
  location.hash = here ? `#/search/${encodeURIComponent(here)}` : '#/search';
});
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

lockMissingPrices().finally(render);
