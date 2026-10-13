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

// jsPDF needs to be told the image format.
const imageFormat = (blob) => (blob.type === 'image/png' ? 'PNG' : 'JPEG');

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
 * propertyPhoto, logo: Blobs or null, for the cover page
 * companyName: string or null
 * groups:   [[zone, findings], ...] in the order they should print
 * zoneName: zone -> "Zone 4" / "No zone"
 * Returns a Blob.
 */
export async function buildReportPdf({ report, property, propertyPhoto, logo, companyName, groups, zoneName }) {
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

  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  const zones = groups.filter(([z]) => z).length;

  // ---------- Cover page ----------
  font('bold', 10);
  color(ACCENT);
  doc.text('WET CHECK REPORT', MARGIN, y + 10);
  y += 24;

  font('bold', 26);
  color(INK);
  for (const l of doc.splitTextToSize(propertyName, CONTENT_W)) {
    doc.text(l, MARGIN, y + 26);
    y += lineHeight(26);
  }
  y += 2;
  font('normal', 13);
  color(MUTED);
  doc.text(`${report.name}  ·  ${formatDate(report.date)}`, MARGIN, y + 13);
  y += 26;

  // Logo area at the bottom of the cover, measured first so the photo can fill what's left.
  const LOGO_MAX_W = 220;
  const LOGO_MAX_H = 90;
  let logoImg = null;
  if (logo) {
    const { w, h } = await imageSize(logo);
    const scale = Math.min(LOGO_MAX_W / w, LOGO_MAX_H / h);
    logoImg = { data: await blobToDataUrl(logo), w: w * scale, h: h * scale, format: imageFormat(logo) };
  }
  const companyH = (logoImg ? logoImg.h + 10 : 0) + (companyName ? 18 : 0);
  const companyTop = PAGE_H - MARGIN - companyH - (logoImg || companyName ? 14 : 0);

  // Summary line under the photo.
  const summary = `${total} finding${total === 1 ? '' : 's'}` + (zones ? ` in ${zones} zone${zones === 1 ? '' : 's'}` : '');
  const summaryH = 34;

  if (propertyPhoto) {
    const { w, h } = await imageSize(propertyPhoto);
    const maxH = companyTop - y - summaryH - 24;
    const scale = Math.min(CONTENT_W / w, maxH / h);
    const pw = w * scale;
    const ph = h * scale;
    doc.addImage(await blobToDataUrl(propertyPhoto), imageFormat(propertyPhoto), MARGIN + (CONTENT_W - pw) / 2, y, pw, ph);
    y += ph + 18;
  }

  doc.setDrawColor(...LINE);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  y += 20;
  font('bold', 14);
  color(INK);
  doc.text(summary, MARGIN, y);

  if (logoImg || companyName) {
    let cy = companyTop;
    font('bold', 8);
    color(MUTED);
    doc.text('PREPARED BY', PAGE_W / 2, cy, { align: 'center' });
    cy += 10;
    if (logoImg) {
      doc.addImage(logoImg.data, logoImg.format, (PAGE_W - logoImg.w) / 2, cy, logoImg.w, logoImg.h, undefined, 'FAST'); // PNGs are stored uncompressed otherwise
      cy += logoImg.h + 10;
    }
    if (companyName) {
      font('bold', 12);
      color(INK);
      doc.text(companyName, PAGE_W / 2, cy + 12, { align: 'center' });
    }
  }

  // Findings start on page 2.
  newPage();

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
      if (f.disclaimer) {
        lines.push({ gap: 4 });
        add('italic', 10, MUTED, f.disclaimer);
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
  for (let p = 2; p <= pages; p++) { // no footer on the cover
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
