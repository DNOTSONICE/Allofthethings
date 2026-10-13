// Builds the wet check report PDF on the device (no upload), using jsPDF.

import { coordsText, mapUrl, stampDetails } from './location.js';
import { formatDate } from './ui.js';

let libPromise = null;

// jsPDF is a plain script, so it's loaded on first export rather than at startup.
function loadJsPdf() {
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './js/vendor/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => {
        libPromise = null;
        reject(new Error('Could not load the PDF tool'));
      };
      document.head.append(s);
    });
  }
  return libPromise;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function imageSize(blob) {
  const bmp = await createImageBitmap(blob);
  const size = { w: bmp.width, h: bmp.height };
  if (bmp.close) bmp.close();
  return size;
}

// Letter size, in points (72 per inch).
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const FOOTER = 30;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PHOTO_W = 230;
const PHOTO_MAX_H = 230;
const GAP = 14;

const INK = [21, 32, 43];
const MUTED = [91, 104, 117];
const ACCENT = [14, 116, 144];
const LINE = [225, 230, 235];

/**
 * report:   { name, date }
 * property: folder names from the top level down, e.g. ["Oak Ridge HOA", "North section"]
 * groups:   [[zone, findings], ...] in the order they should print
 * zoneName: zone -> "Zone 4" / "No zone"
 * Returns a Blob.
 */
export async function buildReportPdf({ report, property, groups, zoneName }) {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: 'pt', format: 'letter' });
  const propertyName = property.join(' / ') || 'Wet check';
  let y = MARGIN;

  const color = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const font = (style, size) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
  };
  const lineHeight = (size) => size * 1.3;

  function newPage() {
    doc.addPage();
    y = MARGIN;
  }
  function ensure(h) {
    if (y + h > PAGE_H - MARGIN - FOOTER) newPage();
  }

  // ---------- Title block ----------
  font('bold', 9);
  color(ACCENT);
  doc.text('WET CHECK REPORT', MARGIN, y + 9);
  y += 18;

  font('bold', 20);
  color(INK);
  for (const l of doc.splitTextToSize(propertyName, CONTENT_W)) {
    doc.text(l, MARGIN, y + 18);
    y += lineHeight(20);
  }

  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  const zones = groups.filter(([z]) => z).length;
  font('normal', 11);
  color(MUTED);
  const summary = `${report.name}  ·  ${formatDate(report.date)}  ·  ${total} finding${total === 1 ? '' : 's'}`
    + (zones ? ` in ${zones} zone${zones === 1 ? '' : 's'}` : '');
  doc.text(summary, MARGIN, y + 11);
  y += 22;

  doc.setDrawColor(...LINE);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 16;

  if (!total) {
    font('normal', 12);
    color(MUTED);
    doc.text('No findings were recorded.', MARGIN, y + 12);
  }

  // ---------- Findings, by zone ----------
  const coordRows = [];

  for (const [zone, items] of groups) {
    const heading = () => {
      ensure(28 + 120); // keep a zone heading with at least the start of its first finding
      doc.setFillColor(240, 246, 248);
      doc.rect(MARGIN, y, CONTENT_W, 22, 'F');
      font('bold', 11);
      color(ACCENT);
      doc.text(`${zoneName(zone)}  ·  ${items.length} finding${items.length === 1 ? '' : 's'}`, MARGIN + 8, y + 15);
      y += 22 + 12;
    };
    heading();

    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const number = i + 1;

      // Photo size, scaled to fit its column.
      let photo = null;
      if (f.photo) {
        const { w, h } = await imageSize(f.photo);
        const scale = Math.min(PHOTO_W / w, PHOTO_MAX_H / h);
        photo = { data: await blobToDataUrl(f.photo), w: w * scale, h: h * scale };
      }

      const textX = MARGIN + (photo ? PHOTO_W + GAP : 0);
      const textW = PAGE_W - MARGIN - textX;

      // Lay out the text first so the row height is known before drawing.
      const lines = [];
      const add = (style, size, c, text, extra = {}) => {
        font(style, size);
        for (const l of doc.splitTextToSize(text, textW)) lines.push({ style, size, c, text: l, ...extra });
      };
      add('bold', 13, INK, `${number}. ${f.issue}`);
      add('normal', 10, MUTED, zoneName(f.zone || ''));
      if (f.note) {
        lines.push({ gap: 6 });
        add('normal', 11, INK, f.note);
      }
      lines.push({ gap: 8 });
      add('bold', 9, MUTED, 'LOCATION');
      if (f.stamp && f.stamp.lat != null) {
        add('bold', 11, INK, coordsText(f.stamp), { link: mapUrl(f.stamp) });
        add('normal', 9, ACCENT, 'Open in map', { link: mapUrl(f.stamp) });
        coordRows.push({ label: `${zoneName(zone)} · ${number}. ${f.issue}`, stamp: f.stamp });
      } else {
        add('normal', 11, MUTED, 'No location recorded');
      }
      const details = stampDetails(f.stamp);
      if (details) add('normal', 9, MUTED, details);

      const textH = lines.reduce((h, l) => h + (l.gap || lineHeight(l.size)), 0);
      const rowH = Math.max(photo ? photo.h : 0, textH);
      if (y + rowH > PAGE_H - MARGIN - FOOTER) {
        newPage();
        // Repeat the zone name at the top of the new page.
        font('bold', 9);
        color(ACCENT);
        doc.text(`${zoneName(zone).toUpperCase()} (CONTINUED)`, MARGIN, y + 9);
        y += 20;
      }

      if (photo) doc.addImage(photo.data, 'JPEG', MARGIN, y, photo.w, photo.h);

      let ty = y;
      for (const l of lines) {
        if (l.gap) {
          ty += l.gap;
          continue;
        }
        font(l.style, l.size);
        color(l.c);
        const baseline = ty + l.size;
        if (l.link) doc.textWithLink(l.text, textX, baseline, { url: l.link });
        else doc.text(l.text, textX, baseline);
        ty += lineHeight(l.size);
      }

      y += rowH + GAP;
      if (i < items.length - 1) {
        doc.setDrawColor(...LINE);
        doc.line(MARGIN, y - GAP / 2, PAGE_W - MARGIN, y - GAP / 2);
      }
    }
    y += 8;
  }

  // ---------- Coordinates list ----------
  if (coordRows.length) {
    ensure(60);
    y += 6;
    font('bold', 14);
    color(INK);
    doc.text('Coordinates', MARGIN, y + 14);
    y += 22;
    font('normal', 9);
    color(MUTED);
    doc.text('Paste into any map app, or tap a coordinate to open it.', MARGIN, y + 9);
    y += 20;

    const colX = MARGIN + CONTENT_W * 0.6;
    for (const r of coordRows) {
      font('normal', 10);
      const labelLines = doc.splitTextToSize(r.label, colX - MARGIN - 10);
      const h = labelLines.length * lineHeight(10) + 8;
      ensure(h);
      color(INK);
      labelLines.forEach((l, k) => doc.text(l, MARGIN, y + 10 + k * lineHeight(10)));
      font('bold', 10);
      color(ACCENT);
      doc.textWithLink(coordsText(r.stamp), colX, y + 10, { url: mapUrl(r.stamp) });
      y += h;
      doc.setDrawColor(...LINE);
      doc.line(MARGIN, y - 4, PAGE_W - MARGIN, y - 4);
    }
  }

  // ---------- Footer on every page ----------
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font('normal', 8);
    color(MUTED);
    doc.text(`${propertyName}  ·  ${formatDate(report.date)}`, MARGIN, PAGE_H - MARGIN + 10);
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 10, { align: 'right' });
  }

  return doc.output('blob');
}

export function pdfFileName(property, report) {
  const base = `${property.join(' - ') || 'Wet check'} ${report.date} ${report.name}`;
  return base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}
