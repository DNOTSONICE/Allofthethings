// The issue list and its prices.
// data/issues.json is the starting list. Once the user edits it in the app (turning issues
// on or off, renaming, adding, pricing), their copy is saved in the settings store as
// 'issueList' and used from then on: { groups: [{ name, issues: [{ name, price, off }] }] }.
// price is a number or null (not priced); off hides an issue from the finding dropdown.

import * as db from './db.js';

let defaults = null;

// An issue in issues.json can be a plain name or { "name": ..., "price": ... }.
function toIssue(item) {
  if (typeof item === 'string') return { name: item, price: null, off: false };
  return { name: String(item.name), price: toPrice(item.price), off: !!item.off };
}

export function toPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

const clone = (list) => ({ groups: list.groups.map((g) => ({ name: g.name, issues: g.issues.map((i) => ({ ...i })) })) });

export async function defaultIssueList() {
  if (!defaults) {
    defaults = fetch('./data/issues.json')
      .then((r) => r.json())
      .then((d) => ({
        // A plain "issues" list (the older format) becomes one unnamed group.
        groups: (d.groups || [{ name: '', issues: d.issues }]).map((g) => ({ name: g.name || '', issues: g.issues.map(toIssue) })),
      }))
      .catch(() => {
        defaults = null;
        return { groups: [{ name: '', issues: [toIssue('Other')] }] };
      });
  }
  return clone(await defaults);
}

export async function loadIssueList() {
  const saved = await db.getSetting('issueList');
  return saved && saved.groups ? clone(saved) : defaultIssueList();
}

export async function saveIssueList(list) {
  await db.setSetting('issueList', clone(list));
}

// Issues added to data/issues.json after people had already edited their own list. A saved
// list never picks up new defaults by itself, so each one here is added to it once (unless it
// is already there); 'issuesAdded' remembers which, so deleting one later keeps it deleted.
const NEW_DEFAULTS = [{ name: 'Broken nozzle', group: 'Head and nozzle adjustments', before: 'Clogged nozzle' }];

export async function addNewDefaults() {
  const saved = await db.getSetting('issueList');
  const done = (await db.getSetting('issuesAdded')) || [];
  const todo = NEW_DEFAULTS.filter((d) => !done.includes(d.name));
  if (!todo.length) return;
  if (saved && saved.groups) {
    const list = clone(saved);
    for (const d of todo) {
      if (findIssue(list, d.name)) continue;
      let g = list.groups.find((x) => x.name === d.group);
      if (!g) list.groups.push((g = { name: d.group, issues: [] }));
      const at = g.issues.findIndex((i) => i.name === d.before);
      g.issues.splice(at < 0 ? 0 : at, 0, { name: d.name, price: null, off: false });
    }
    await saveIssueList(list);
  }
  await db.setSetting('issuesAdded', [...done, ...todo.map((d) => d.name)]);
}

// Back to data/issues.json, dropping the user's edits and prices.
export async function resetIssueList() {
  await db.setSetting('issueList', null);
}

export function findIssue(list, name) {
  for (const g of list.groups) {
    const issue = g.issues.find((i) => i.name === name);
    if (issue) return issue;
  }
  return null;
}

export function priceOf(list, name) {
  const issue = findIssue(list, name);
  return issue ? issue.price : null;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatMoney = (n) => money.format(n);

// ---------- Property profiles ----------
// A top-level property folder can carry folder.profile:
// { issues: { [issue name]: { price?, off? } }, added: [{ group, name, price, off }],
//   disclaimer: string|null, contact: { name, phone, email, address } }
// Only what the user changed is stored, so everything else keeps following the main list.

// The main list with a property's changes applied. Changed issues get custom: true (plus
// mainPrice/mainOff to show what they override); property-only issues get own: true.
export function effectiveList(list, profile) {
  if (!profile) return list;
  const over = profile.issues || {};
  const out = {
    groups: list.groups.map((g) => ({
      name: g.name,
      issues: g.issues.map((i) => {
        const o = over[i.name];
        if (!o) return { ...i };
        const changed = { ...i, custom: true, mainPrice: i.price, mainOff: !!i.off };
        if ('price' in o) changed.price = o.price;
        if ('off' in o) changed.off = o.off;
        return changed;
      }),
    })),
  };
  for (const a of profile.added || []) {
    let g = out.groups.find((x) => x.name === a.group);
    if (!g) {
      g = { name: a.group || 'Property issues', issues: [] };
      out.groups.push(g);
    }
    g.issues.push({ name: a.name, price: a.price ?? null, off: !!a.off, own: true });
  }
  return out;
}

// The prices a report keeps from the day it was created: { issue name: price }.
export function priceSnapshot(list) {
  const out = {};
  for (const g of list.groups) for (const i of g.issues) if (i.price != null) out[i.name] = i.price;
  return out;
}

// What a finding costs: a price typed on the finding, else the report's prices from when it
// was created, else (for an issue that had no price then) the current list.
export function findingPrice(finding, list, snapshot = null) {
  if (finding.price != null) return finding.price;
  if (snapshot && snapshot[finding.issue] != null) return snapshot[finding.issue];
  return priceOf(list, finding.issue);
}

// Repair estimate lines for a report: one line per issue and price, with how many and which zones.
// Returns { lines: [{ issue, unit, qty, amount, zones }], total, unpriced, prices: [[findingId, price]] }.
// adjustment: the report's discount, { type: 'amount' | 'percent', value, label? }, or null.
// The result's total is after the discount; subtotal is before it.
export function buildEstimate(findings, list, snapshot = null, adjustment = null) {
  const lines = new Map();
  const prices = [];
  for (const f of findings) {
    if (f.mark === 'ok') continue; // a zone marked "no issues found" isn't a repair
    const unit = findingPrice(f, list, snapshot);
    prices.push([f.id, unit]);
    const key = `${f.issue}\u0000${unit}`;
    if (!lines.has(key)) lines.set(key, { issue: f.issue, unit, qty: 0, amount: null, zones: [] });
    const line = lines.get(key);
    line.qty += 1;
    if (f.zone && !line.zones.includes(f.zone)) line.zones.push(f.zone);
  }
  let total = 0;
  let unpriced = 0;
  for (const line of lines.values()) {
    line.zones.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (line.unit == null) unpriced += line.qty;
    else {
      line.amount = Math.round(line.unit * line.qty * 100) / 100;
      total += line.amount;
    }
  }
  const subtotal = Math.round(total * 100) / 100;
  const discount = discountAmount(subtotal, adjustment);
  return {
    lines: [...lines.values()],
    subtotal,
    discount,
    discountLabel: discount ? discountLabel(adjustment) : '',
    total: Math.round((subtotal - discount) * 100) / 100,
    unpriced,
    prices,
  };
}

// The discount in dollars, never more than the subtotal.
export function discountAmount(subtotal, adj) {
  if (!adj || !(adj.value > 0)) return 0;
  const d = adj.type === 'percent' ? (subtotal * Math.min(adj.value, 100)) / 100 : adj.value;
  return Math.round(Math.min(d, subtotal) * 100) / 100;
}

// "Discount (10%)" or the label typed for it, e.g. "HOA loyalty discount (10%)".
export function discountLabel(adj) {
  const base = (adj.label || '').trim() || 'Discount';
  return adj.type === 'percent' ? `${base} (${+adj.value.toFixed(2)}%)` : base;
}
