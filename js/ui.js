// Shared dialogs: name prompt, action sheet, confirmation.

const $ = (sel) => document.querySelector(sel);

// Resolves with returnValue when the dialog closes.
export function showDialog(dialog) {
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
  });
}

// Shows the name dialog and resolves with the trimmed name, or null if cancelled.
export async function askName(title, submitLabel, initial = '') {
  const input = $('#name-input');
  $('#name-title').textContent = title;
  $('#name-submit').textContent = submitLabel;
  input.value = initial;
  const result = showDialog($('#name-dialog'));
  input.focus();
  input.select();
  const ok = (await result) === 'ok';
  const v = input.value.trim();
  return ok && v ? v : null;
}

// actions: [{ label, value, danger? }]. Resolves with the chosen value, or '' if cancelled.
export function askAction(title, actions) {
  const dialog = $('#menu-dialog');
  $('#menu-title').textContent = title;
  const box = $('#menu-items');
  box.replaceChildren(...[...actions, { label: 'Cancel', value: 'cancel' }].map((a) => {
    const b = document.createElement('button');
    b.className = 'sheet-item' + (a.danger ? ' danger' : '');
    b.value = a.value;
    b.textContent = a.label;
    return b;
  }));
  return showDialog(dialog).then((v) => (v === 'cancel' ? '' : v));
}

export async function askConfirm(title, text, okLabel = 'Delete') {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  return (await showDialog($('#confirm-dialog'))) === 'ok';
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "2026-10-13" -> "Oct 13, 2026", read as a local date (no timezone shift).
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Tapping the dim area outside a dialog closes it.
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close('cancel');
  });
}

// Forms that need validation close their dialog with "ok" on submit.
for (const form of document.querySelectorAll('form[data-ok]')) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    form.closest('dialog').close('ok');
  });
}
