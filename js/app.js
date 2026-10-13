import * as db from './db.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  title: $('#title'),
  back: $('#back'),
  crumbs: $('#crumbs'),
  list: $('#list'),
  empty: $('#empty'),
  fab: $('#new-folder'),
  nameDialog: $('#name-dialog'),
  nameForm: $('#name-form'),
  nameTitle: $('#name-title'),
  nameInput: $('#name-input'),
  nameSubmit: $('#name-submit'),
  menuDialog: $('#menu-dialog'),
  menuTitle: $('#menu-title'),
  confirmDialog: $('#confirm-dialog'),
  confirmText: $('#confirm-text'),
};

// Current folder id comes from the URL hash (#/f/<id>) so the phone's back button works.
function currentId() {
  const m = location.hash.match(/^#\/f\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : db.ROOT;
}

function go(id) {
  location.hash = id === db.ROOT ? '#/' : `#/f/${encodeURIComponent(id)}`;
}

async function render() {
  const id = currentId();
  const path = id === db.ROOT ? [] : await db.getPath(id);
  if (id !== db.ROOT && path.length === 0) return go(db.ROOT); // folder no longer exists

  const here = path[path.length - 1];
  els.title.textContent = here ? here.name : 'Properties';
  document.title = here ? `${here.name} · Wet Check` : 'Wet Check';
  els.back.hidden = !here;

  els.crumbs.replaceChildren();
  els.crumbs.hidden = path.length < 2;
  const crumbList = [{ id: db.ROOT, name: 'Properties' }, ...path.slice(0, -1)];
  for (const c of crumbList) {
    const a = document.createElement('a');
    a.href = c.id === db.ROOT ? '#/' : `#/f/${encodeURIComponent(c.id)}`;
    a.textContent = c.name;
    els.crumbs.append(a, document.createTextNode(' › '));
  }

  const children = await db.listChildren(id);
  els.list.replaceChildren(...children.map(folderRow));
  els.empty.hidden = children.length > 0;
}

function folderRow(folder) {
  const li = document.createElement('li');
  li.className = 'row';

  const open = document.createElement('button');
  open.className = 'row-open';
  open.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = folder.name;
  open.append(name);
  open.addEventListener('click', () => go(folder.id));

  const more = document.createElement('button');
  more.className = 'row-more';
  more.setAttribute('aria-label', `Options for ${folder.name}`);
  more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  more.addEventListener('click', () => openMenu(folder));

  li.append(open, more);
  return li;
}

// Shows the name dialog and resolves with the trimmed name, or null if cancelled.
function askName(title, submitLabel, initial = '') {
  els.nameTitle.textContent = title;
  els.nameSubmit.textContent = submitLabel;
  els.nameInput.value = initial;
  els.nameDialog.showModal();
  els.nameInput.focus();
  els.nameInput.select();
  return new Promise((resolve) => {
    els.nameDialog.addEventListener('close', () => {
      const v = els.nameInput.value.trim();
      resolve(els.nameDialog.returnValue === 'ok' && v ? v : null);
    }, { once: true });
  });
}

function askConfirm(text) {
  els.confirmText.textContent = text;
  els.confirmDialog.showModal();
  return new Promise((resolve) => {
    els.confirmDialog.addEventListener('close', () => resolve(els.confirmDialog.returnValue === 'ok'), { once: true });
  });
}

function openMenu(folder) {
  els.menuTitle.textContent = folder.name;
  els.menuDialog.returnValue = '';
  els.menuDialog.showModal();
  els.menuDialog.addEventListener('close', async () => {
    const action = els.menuDialog.returnValue;
    if (action === 'rename') await renameFlow(folder);
    if (action === 'delete') await deleteFlow(folder);
  }, { once: true });
}

async function newFolderFlow() {
  const name = await askName('New folder', 'Create');
  if (!name) return;
  await db.createFolder(name, currentId());
  render();
}

async function renameFlow(folder) {
  const name = await askName('Rename folder', 'Save', folder.name);
  if (!name || name === folder.name) return;
  await db.renameFolder(folder.id, name);
  render();
}

async function deleteFlow(folder) {
  const { folders } = await db.countContents(folder.id);
  let text = `Delete “${folder.name}”?`;
  if (folders > 0) {
    text += ` It contains ${folders} folder${folders === 1 ? '' : 's'}, which will also be deleted.`;
  }
  text += ' This can’t be undone.';
  if (!(await askConfirm(text))) return;
  await db.deleteFolder(folder.id);
  render();
}

// Tapping the dim area outside a dialog closes it.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('cancel');
  });
}

els.nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  els.nameDialog.close('ok');
});

els.back.addEventListener('click', async () => {
  const f = await db.getFolder(currentId());
  go(f ? f.parentId : db.ROOT);
});
els.fab.addEventListener('click', newFolderFlow);
window.addEventListener('hashchange', render);

// Ask the browser not to evict our data when storage is low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

render();
