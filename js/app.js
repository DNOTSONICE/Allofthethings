import * as db from './db.js';
import { showDialog, askName, askAction, askConfirm, plural, formatDate, today } from './ui.js';
import { compressPhoto } from './photo.js';
import { loadIssues } from './issues.js';

const $ = (sel) => document.querySelector(sel);

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
  showView('folder');
}

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
    { label: 'Edit name and date', value: 'edit' },
    { label: 'Delete', value: 'delete', danger: true },
  ]);
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
  $('#fab-label').textContent = 'Add finding';

  const findings = await db.listFindings(id);
  for (const u of photoUrls) URL.revokeObjectURL(u);
  photoUrls = [];
  $('#finding-list').replaceChildren(...findings.map((f, i) => findingCard(f, i + 1)));
  $('#report-empty').hidden = findings.length > 0;
  showView('report');
}

function findingCard(finding, number) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'card';
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
  if (finding.zone) {
    const z = document.createElement('div');
    z.className = 'card-zone';
    z.textContent = `Zone ${finding.zone}`;
    body.append(z);
  }
  if (finding.note) {
    const n = document.createElement('div');
    n.className = 'card-note';
    n.textContent = finding.note;
    body.append(n);
  }
  btn.append(body);
  li.append(btn);
  return li;
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
  error: $('#photo-error'),
  issue: $('#finding-issue'),
  zone: $('#finding-zone'),
  note: $('#finding-note'),
  del: $('#finding-delete'),
  photo: null, // compressed Blob
  busy: false,
};

function setPhoto(blob) {
  form.photo = blob;
  if (form.img.src) URL.revokeObjectURL(form.img.src);
  form.img.removeAttribute('src');
  if (blob) form.img.src = URL.createObjectURL(blob);
  form.preview.hidden = !blob;
}

function showPhotoError(msg) {
  form.error.textContent = msg;
  form.error.hidden = !msg;
}

async function onPhotoPicked(e) {
  const file = e.target.files[0];
  e.target.value = ''; // lets the same photo be picked again
  if (!file) return;
  showPhotoError('');
  form.busy = true;
  try {
    setPhoto(await compressPhoto(file));
  } catch {
    showPhotoError('That photo couldn’t be read. Try another one.');
  } finally {
    form.busy = false;
  }
}

$('#photo-camera').addEventListener('change', onPhotoPicked);
$('#photo-library').addEventListener('change', onPhotoPicked);

$('#finding-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (form.busy) return;
  if (!form.photo) {
    showPhotoError('Add a photo first.');
    return;
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
  setPhoto(finding ? finding.photo : null);
  await fillIssues(finding ? finding.issue : '');
  form.zone.value = finding ? finding.zone : '';
  form.note.value = finding ? finding.note : '';
  form.dialog.scrollTop = 0;
  const result = await showDialog(form.dialog);
  const fields = { photo: form.photo, issue: form.issue.value, zone: form.zone.value.trim(), note: form.note.value.trim() };
  setPhoto(null);
  return { result, fields };
}

async function addFinding() {
  const { result, fields } = await openFindingForm(null);
  if (result !== 'ok') return;
  await db.saveFinding(current.id, fields);
  await render();
  window.scrollTo(0, document.body.scrollHeight); // show the finding just added
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

$('#header-more').addEventListener('click', () => current.kind === 'report' && reportMenu(current.record));

$('#fab').addEventListener('click', () => (current.kind === 'report' ? addFinding() : newInFolder()));

window.addEventListener('hashchange', render);

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

render();
