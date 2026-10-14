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

// What a finding costs: its own price if one was typed on the finding, otherwise the price list.
export const findingPrice = (finding, list) => (finding.price != null ? finding.price : priceOf(list, finding.issue));

// Repair estimate lines for a report: one line per issue and price, with how many and which zones.
// Returns { lines: [{ issue, unit, qty, amount, zones }], total, unpriced, prices: [[findingId, price]] }.
export function buildEstimate(findings, list) {
  const lines = new Map();
  const prices = [];
  for (const f of findings) {
    const unit = findingPrice(f, list);
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
  return { lines: [...lines.values()], total: Math.round(total * 100) / 100, unpriced, prices };
}
