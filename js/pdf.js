// Builds the wet check report PDF on the device (no upload), using jsPDF.

import { coordsText, stampDetails } from './location.js';
import { formatDate } from './ui.js';
import { formatMoney } from './issues.js';

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

// Reads a stored photo into what jsPDF needs. The size comes from the image file's own header
// (jsPDF's getImageProperties), not createImageBitmap, which Safari sometimes refuses for photos
// stored in IndexedDB. Returns null if the photo can't be read, so one bad photo
// doesn't stop the whole export.
async function loadImage(doc, blob) {
  try {
    const data = await blobToDataUrl(blob);
    let w;
    let h;
    let format;
    try {
      const props = doc.getImageProperties(data);
      ({ width: w, height: h } = props);
      format = props.fileType === 'PNG' ? 'PNG' : 'JPEG';
    } catch {
      const img = new Image();
      img.src = data;
      await img.decode();
      w = img.naturalWidth;
      h = img.naturalHeight;
      format = data.startsWith('data:image/png') ? 'PNG' : 'JPEG';
    }
    if (!w || !h) return null;
    return { data, w, h, format };
  } catch (err) {
    console.warn('Skipped a photo in the PDF', err);
    return null;
  }
}

// Google Maps link for the PDF: it opens on any phone or computer the report is sent to
// (the Google Maps app if installed, otherwise the browser).
const pdfMapUrl = (stamp) => `https://www.google.com/maps/search/?api=1&query=${stamp.lat.toFixed(6)},${stamp.lon.toFixed(6)}`;

// Letter size, in points (72 per inch).
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 48;
const HEADER_H = 40; // running header on inside pages
const FOOTER_H = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const PHOTO_W = 220;
const PHOTO_MAX_H = 220;
const GAP = 16;

const INK = [24, 33, 43];
const MUTED = [98, 110, 122];
const LINE = [222, 227, 232];
const WHITE = [255, 255, 255];

export const DEFAULT_ACCENT = '#1e5aa8';

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt(m ? m[1] : DEFAULT_ACCENT.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The accent mixed with white: 0 = accent, 1 = white. Used for light panels.
const tint = (c, amount) => c.map((v) => Math.round(v + (255 - v) * amount));

/**
 * report:   { name, date }
 * property: folder names from the top level down, e.g. ["Oak Ridge HOA", "North section"]
 * propertyPhoto, logo: Blobs or null, for the cover page
 * companyName: string or null
 * accent:   hex color for accent lines, e.g. "#1e5aa8"
 * groups:   [[zone, findings], ...] in the order they should print
 * zoneName: zone -> "Zone 4" / "No zone"
 * estimate: null, or buildEstimate() from issues.js for a repair estimate page
 * Returns a Blob.
 */
export async function buildReportPdf({ report, property, propertyPhoto, logo, companyName, accent, groups, zoneName, estimate = null }) {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: 'pt', format: 'letter' });
  const propertyName = property.join(' / ') || 'Wet check';
  const ACCENT = hexToRgb(accent);
  const ACCENT_SOFT = tint(ACCENT, 0.9);
  const ACCENT_MID = tint(ACCENT, 0.55);
  const bodyTop = MARGIN + HEADER_H;
  const bodyBottom = PAGE_H - MARGIN - FOOTER_H;
  let y = MARGIN;

  const color = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const fill = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const stroke = (c, w = 1) => {
    doc.setDrawColor(c[0], c[1], c[2]);
    doc.setLineWidth(w);
  };
  const font = (style, size) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
  };
  const lineHeight = (size) => size * 1.32;
  // Letter-spaced small caps-style labels.
  const label = (text, x, yy, c = ACCENT, size = 8, opts = {}) => {
    font('bold', size);
    color(c);
    doc.text(text.toUpperCase(), x, yy, { charSpace: 1.2, ...opts });
  };

  // Underlined, tappable text. jsPDF's textWithLink writes the tap area upside down and only
  // as tall as the letters, which some viewers (Apple's among them) ignore, so draw it here
  // with a little padding. A negative height gives a rectangle in the normal orientation.
  function linkText(text, x, baseline, url) {
    const size = doc.getFontSize();
    const w = doc.getTextWidth(text);
    doc.text(text, x, baseline);
    stroke(ACCENT, 0.6);
    doc.line(x, baseline + 1.6, x + w, baseline + 1.6);
    doc.link(x - 3, baseline + 5, w + 6, -(size + 8), { url });
  }

  function newPage() {
    doc.addPage();
    y = bodyTop;
  }
  function ensure(h) {
    if (y + h > bodyBottom) newPage();
  }

  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  const findingPrices = new Map(estimate ? estimate.prices : []);
  const zones = groups.filter(([z]) => z).length;
  const located = groups.reduce((n, [, items]) => n + items.filter((f) => f.stamp && f.stamp.lat != null).length, 0);

  let logoImg = null;
  if (logo) logoImg = await loadImage(doc, logo);
  const fitLogo = (maxW, maxH) => {
    const s = Math.min(maxW / logoImg.w, maxH / logoImg.h);
    return { w: logoImg.w * s, h: logoImg.h * s };
  };

  // ================= Cover page =================
  // Accent band across the top, and a slim bar down the left edge.
  fill(ACCENT);
  doc.rect(0, 0, PAGE_W, 10, 'F');
  fill(ACCENT_MID);
  doc.rect(0, 10, PAGE_W, 3, 'F');
  fill(ACCENT);
  doc.rect(0, 0, 6, PAGE_H, 'F');

  y = 70;
  label('Wet check report', MARGIN, y, ACCENT, 9);
  y += 14;

  font('bold', 28);
  color(INK);
  for (const l of doc.splitTextToSize(propertyName, CONTENT_W)) {
    doc.text(l, MARGIN, y + 26);
    y += lineHeight(28);
  }
  // Short accent rule under the title.
  fill(ACCENT);
  doc.rect(MARGIN, y + 8, 56, 3, 'F');
  y += 30;

  // Details: two columns of label / value.
  const details = [
    ['Report', report.name],
    ['Inspection date', formatDate(report.date)],
  ];
  if (companyName) details.push(['Prepared by', companyName]);
  const colW = CONTENT_W / details.length;
  details.forEach(([k, v], i) => {
    const x = MARGIN + i * colW;
    label(k, x, y, MUTED, 7.5);
    font('bold', 11.5);
    color(INK);
    doc.text(doc.splitTextToSize(v, colW - 12)[0], x, y + 16);
  });
  y += 34;

  // Space for the bottom block (stats + logo), so the photo can fill what's left.
  const statsH = 64;
  const logoBox = logoImg ? fitLogo(200, 70) : null;
  const bottomH = statsH + 26 + (logoBox ? logoBox.h + 34 : companyName ? 40 : 0);
  const bottomTop = PAGE_H - MARGIN - bottomH;

  const coverImg = propertyPhoto ? await loadImage(doc, propertyPhoto) : null;
  if (coverImg) {
    const { w, h } = coverImg;
    const maxH = bottomTop - y - 22;
    const s = Math.min(CONTENT_W / w, maxH / h);
    const pw = w * s;
    const ph = h * s;
    const px = MARGIN + (CONTENT_W - pw) / 2;
    doc.addImage(coverImg.data, coverImg.format, px, y, pw, ph);
    // Accent underline on the photo, like a caption rule.
    fill(ACCENT);
    doc.rect(px, y + ph, pw, 4, 'F');
    y += ph + 4;
  } else {
    stroke(LINE);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  }

  // Stat tiles: findings / zones / locations.
  let sy = bottomTop;
  const stats = [
    [String(total), total === 1 ? 'Finding' : 'Findings'],
    [String(zones), zones === 1 ? 'Zone' : 'Zones'],
    [String(located), located === 1 ? 'Location mapped' : 'Locations mapped'],
  ];
  if (estimate) stats.push([formatMoney(estimate.total), 'Repair estimate']);
  const tileW = (CONTENT_W - 8 * (stats.length - 1)) / stats.length;
  stats.forEach(([n, k], i) => {
    const x = MARGIN + i * (tileW + 8);
    fill(ACCENT_SOFT);
    doc.rect(x, sy, tileW, statsH, 'F');
    fill(ACCENT);
    doc.rect(x, sy, 3, statsH, 'F');
    font('bold', 24);
    // Shrink long numbers (estimate totals) to fit the tile.
    doc.setFontSize(Math.min(24, (24 * (tileW - 24)) / doc.getTextWidth(n)));
    color(ACCENT);
    doc.text(n, x + 16, sy + 34);
    label(k, x + 16, sy + 50, MUTED, 7.5);
  });
  sy += statsH + 26;

  if (logoBox || companyName) {
    stroke(ACCENT, 1);
    doc.line(MARGIN, sy - 12, PAGE_W - MARGIN, sy - 12);
    label('Prepared by', MARGIN, sy + 4, MUTED, 7.5);
    if (logoBox) {
      doc.addImage(logoImg.data, logoImg.format, MARGIN, sy + 12, logoBox.w, logoBox.h, undefined, 'FAST'); // PNGs are stored uncompressed otherwise
      if (companyName) {
        font('bold', 12);
        color(INK);
        doc.text(companyName, PAGE_W - MARGIN, sy + 12 + logoBox.h / 2 + 4, { align: 'right' });
      }
    } else {
      font('bold', 14);
      color(INK);
      doc.text(companyName, MARGIN, sy + 24);
    }
  }
  fill(ACCENT);
  doc.rect(0, PAGE_H - 6, PAGE_W, 6, 'F');

  // ================= Findings =================
  newPage();

  font('bold', 18);
  color(INK);
  doc.text('Findings', MARGIN, y + 18);
  fill(ACCENT);
  doc.rect(MARGIN, y + 26, 40, 3, 'F');
  y += 44;

  if (!total) {
    font('normal', 12);
    color(MUTED);
    doc.text('No findings were recorded.', MARGIN, y + 12);
    y += 30;
  }

  const zoneHeading = (zone, count, continued = false) => {
    fill(ACCENT);
    doc.rect(MARGIN, y, 4, 20, 'F');
    font('bold', 13);
    color(INK);
    const title = zoneName(zone) + (continued ? ' (continued)' : '');
    doc.text(title, MARGIN + 12, y + 14.5);
    const tw = doc.getTextWidth(title);
    font('normal', 9);
    color(MUTED);
    const countText = `${count} finding${count === 1 ? '' : 's'}`;
    doc.text(countText, PAGE_W - MARGIN, y + 14, { align: 'right' });
    // Accent line running from the title to the count.
    stroke(ACCENT_MID, 0.8);
    doc.line(MARGIN + 12 + tw + 10, y + 10, PAGE_W - MARGIN - doc.getTextWidth(countText) - 10, y + 10);
    y += 20 + 14;
  };

  const tableRows = [];

  for (const [zone, items] of groups) {
    ensure(34 + 140); // keep a zone heading with the start of its first finding
    zoneHeading(zone, items.length);

    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      const number = i + 1;

      let photo = null;
      const img = f.photo ? await loadImage(doc, f.photo) : null;
      if (img) {
        const s = Math.min(PHOTO_W / img.w, PHOTO_MAX_H / img.h);
        photo = { data: img.data, format: img.format, w: img.w * s, h: img.h * s };
      }

      const textX = MARGIN + (photo ? PHOTO_W + GAP + 4 : 0);
      const textW = PAGE_W - MARGIN - textX;
      const badge = 20; // numbered circle beside the issue
      const titleX = textX + badge + 8;

      // Lay out the text first so the row height is known before drawing.
      const lines = [];
      const add = (style, size, c, text, extra = {}) => {
        const x = extra.x || textX;
        font(style, size);
        for (const l of doc.splitTextToSize(text, PAGE_W - MARGIN - x)) lines.push({ style, size, c, text: l, x, ...extra });
      };
      add('bold', 13, INK, f.issue, { x: titleX });
      let sub = zoneName(f.zone || '');
      if (estimate) {
        const price = findingPrices.get(f.id);
        sub += `  ·  ${price == null ? 'No price' : formatMoney(price)}`;
      }
      add('normal', 9.5, MUTED, sub, { x: titleX });
      if (f.note) {
        lines.push({ gap: 8 });
        add('normal', 10.5, INK, f.note);
      }
      if (f.disclaimer) {
        lines.push({ gap: 5 });
        add('italic', 9.5, MUTED, f.disclaimer);
      }
      lines.push({ gap: 10, rule: true });
      lines.push({ label: 'Location', size: 7.5 });
      if (f.stamp && f.stamp.lat != null) {
        add('bold', 11, ACCENT, coordsText(f.stamp), { link: pdfMapUrl(f.stamp) });
        tableRows.push({ zone: zoneName(zone), n: number, issue: f.issue, stamp: f.stamp });
      } else {
        add('normal', 10.5, MUTED, 'No location recorded');
        tableRows.push({ zone: zoneName(zone), n: number, issue: f.issue, stamp: null });
      }
      const extra = stampDetails(f.stamp);
      if (extra) add('normal', 8.5, MUTED, extra);

      const textH = lines.reduce((h, l) => h + (l.gap || lineHeight(l.size)), 0);
      const rowH = Math.max(photo ? photo.h : 0, textH);
      if (y + rowH > bodyBottom) {
        newPage();
        zoneHeading(zone, items.length, true);
      }

      if (photo) {
        doc.addImage(photo.data, photo.format, MARGIN, y, photo.w, photo.h);
        stroke(LINE, 0.5);
        doc.rect(MARGIN, y, photo.w, photo.h, 'S');
      }

      // Number badge.
      fill(ACCENT);
      doc.circle(textX + badge / 2, y + badge / 2 - 2, badge / 2, 'F');
      font('bold', 10);
      color(WHITE);
      doc.text(String(number), textX + badge / 2, y + badge / 2 + 1.5, { align: 'center' });

      let ty = y;
      for (const l of lines) {
        if (l.gap) {
          if (l.rule) {
            stroke(ACCENT_MID, 0.6);
            doc.line(textX, ty + l.gap / 2, textX + 36, ty + l.gap / 2);
          }
          ty += l.gap;
          continue;
        }
        if (l.label) {
          label(l.label, textX, ty + l.size, ACCENT, l.size);
          ty += lineHeight(l.size) + 1;
          continue;
        }
        font(l.style, l.size);
        color(l.c);
        const baseline = ty + l.size;
        if (l.link) linkText(l.text, l.x, baseline, l.link);
        else doc.text(l.text, l.x, baseline);
        ty += lineHeight(l.size);
      }

      y += rowH;

      // More photos: a row of three under the finding.
      const more = [];
      for (const blob of f.morePhotos || []) {
        const m = await loadImage(doc, blob);
        if (m) more.push(m);
      }
      const cellW = (CONTENT_W - 2 * 10) / 3;
      const cellH = 150;
      for (let r = 0; r < more.length; r += 3) {
        const row = more.slice(r, r + 3).map((m) => {
          const s = Math.min(cellW / m.w, cellH / m.h);
          return { ...m, dw: m.w * s, dh: m.h * s };
        });
        const h = Math.max(...row.map((m) => m.dh));
        if (y + 10 + h > bodyBottom) {
          newPage();
          zoneHeading(zone, items.length, true);
        } else y += 10;
        row.forEach((m, k) => {
          const x = MARGIN + k * (cellW + 10);
          doc.addImage(m.data, m.format, x, y, m.dw, m.dh);
          stroke(LINE, 0.5);
          doc.rect(x, y, m.dw, m.dh, 'S');
        });
        y += h;
      }

      y += GAP;
      if (i < items.length - 1) {
        stroke(LINE, 0.75);
        doc.line(MARGIN, y - GAP / 2, PAGE_W - MARGIN, y - GAP / 2);
      }
    }
    y += 14;
  }

  // ================= Summary table =================
  if (tableRows.length) {
    ensure(110);
    y += 4;
    font('bold', 18);
    color(INK);
    doc.text('Summary of findings', MARGIN, y + 18);
    fill(ACCENT);
    doc.rect(MARGIN, y + 26, 40, 3, 'F');
    y += 38;
    font('normal', 9);
    color(MUTED);
    doc.text('Tap a location to open it in a map app, or paste the coordinates into any map search.', MARGIN, y + 9);
    y += 22;

    const cols = [
      { title: 'Zone', x: MARGIN + 10, w: 70 },
      { title: '#', x: MARGIN + 82, w: 20 },
      { title: 'Issue', x: MARGIN + 106, w: 230 },
      { title: 'Location', x: MARGIN + 346, w: CONTENT_W - 356 },
    ];
    const head = () => {
      fill(ACCENT);
      doc.rect(MARGIN, y, CONTENT_W, 22, 'F');
      for (const c of cols) label(c.title, c.x, y + 14.5, WHITE, 7.5);
      y += 22;
    };
    head();
    tableRows.forEach((r, k) => {
      font('normal', 9.5);
      const issueLines = doc.splitTextToSize(r.issue, cols[2].w);
      const h = Math.max(1, issueLines.length) * lineHeight(9.5) + 10;
      if (y + h > bodyBottom) {
        newPage();
        head();
      }
      if (k % 2) {
        fill(ACCENT_SOFT);
        doc.rect(MARGIN, y, CONTENT_W, h, 'F');
      }
      const base = y + 6 + 9.5;
      color(INK);
      doc.text(r.zone, cols[0].x, base);
      doc.text(String(r.n), cols[1].x, base);
      issueLines.forEach((l, j) => doc.text(l, cols[2].x, base + j * lineHeight(9.5)));
      if (r.stamp) {
        font('bold', 9.5);
        color(ACCENT);
        linkText(coordsText(r.stamp), cols[3].x, base, pdfMapUrl(r.stamp));
      } else {
        color(MUTED);
        doc.text('—', cols[3].x, base);
      }
      y += h;
    });
    stroke(ACCENT, 1);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
  }

  // ================= Repair estimate =================
  if (estimate && estimate.lines.length) {
    newPage();
    font('bold', 18);
    color(INK);
    doc.text('Repair estimate', MARGIN, y + 18);
    fill(ACCENT);
    doc.rect(MARGIN, y + 26, 40, 3, 'F');
    y += 38;
    font('normal', 9);
    color(MUTED);
    doc.text(`Repairs for the findings in this report${companyName ? `, from ${companyName}` : ''}.`, MARGIN, y + 9);
    y += 22;

    const right = PAGE_W - MARGIN - 10;
    const cols = [
      { title: 'Repair', x: MARGIN + 10, w: 250 },
      { title: 'Qty', x: right - 170, align: 'right' },
      { title: 'Unit price', x: right - 80, align: 'right' },
      { title: 'Amount', x: right, align: 'right' },
    ];
    const head = () => {
      fill(ACCENT);
      doc.rect(MARGIN, y, CONTENT_W, 22, 'F');
      for (const c of cols) label(c.title, c.x, y + 14.5, WHITE, 7.5, c.align ? { align: c.align } : {});
      y += 22;
    };
    head();
    estimate.lines.forEach((l, k) => {
      font('normal', 10);
      const nameLines = doc.splitTextToSize(l.issue, cols[0].w);
      const zonesText = l.zones.length ? `${l.zones.length === 1 ? 'Zone' : 'Zones'} ${l.zones.join(', ')}` : '';
      const h = nameLines.length * lineHeight(10) + (zonesText ? lineHeight(8.5) : 0) + 12;
      if (y + h > bodyBottom) {
        newPage();
        head();
      }
      if (k % 2) {
        fill(ACCENT_SOFT);
        doc.rect(MARGIN, y, CONTENT_W, h, 'F');
      }
      const base = y + 7 + 10;
      color(INK);
      font('normal', 10);
      nameLines.forEach((t, j) => doc.text(t, cols[0].x, base + j * lineHeight(10)));
      if (zonesText) {
        font('normal', 8.5);
        color(MUTED);
        doc.text(zonesText, cols[0].x, base + nameLines.length * lineHeight(10) - 1);
      }
      font('normal', 10);
      color(INK);
      doc.text(String(l.qty), cols[1].x, base, { align: 'right' });
      if (l.unit == null) {
        color(MUTED);
        doc.text('Not priced', cols[2].x, base, { align: 'right' });
        doc.text('—', cols[3].x, base, { align: 'right' });
      } else {
        doc.text(formatMoney(l.unit), cols[2].x, base, { align: 'right' });
        font('bold', 10);
        doc.text(formatMoney(l.amount), cols[3].x, base, { align: 'right' });
      }
      y += h;
    });

    // Total.
    ensure(60);
    stroke(ACCENT, 1);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 10;
    fill(ACCENT_SOFT);
    doc.rect(PAGE_W - MARGIN - 220, y, 220, 36, 'F');
    fill(ACCENT);
    doc.rect(PAGE_W - MARGIN - 220, y, 3, 36, 'F');
    label('Estimate total', PAGE_W - MARGIN - 205, y + 22, MUTED, 8);
    font('bold', 16);
    color(ACCENT);
    doc.text(formatMoney(estimate.total), right, y + 24, { align: 'right' });
    y += 48;
    if (estimate.unpriced) {
      font('italic', 9);
      color(MUTED);
      const n = estimate.unpriced;
      doc.text(`${n} ${n === 1 ? 'finding is' : 'findings are'} not priced and not included in the total.`, MARGIN, y + 9);
      y += 18;
    }
  }

  // ================= Header and footer on inside pages =================
  const pages = doc.getNumberOfPages();
  for (let p = 2; p <= pages; p++) {
    doc.setPage(p);
    fill(ACCENT);
    doc.rect(0, 0, PAGE_W, 5, 'F');
    // Header: company (or report title) left, property and date right, accent rule under.
    if (logoImg) {
      const lb = fitLogo(90, 22);
      doc.addImage(logoImg.data, logoImg.format, MARGIN, MARGIN - 8, lb.w, lb.h, 'logo', 'FAST');
    } else {
      label(companyName || 'Wet check report', MARGIN, MARGIN + 8, ACCENT, 8);
    }
    font('normal', 8.5);
    color(MUTED);
    doc.text(`${propertyName}  ·  ${formatDate(report.date)}`, PAGE_W - MARGIN, MARGIN + 8, { align: 'right' });
    stroke(ACCENT, 1.2);
    doc.line(MARGIN, MARGIN + 18, PAGE_W - MARGIN, MARGIN + 18);

    // Footer: thin rule, report name left, page number right.
    const fy = PAGE_H - MARGIN + 6;
    stroke(LINE, 0.75);
    doc.line(MARGIN, fy - 14, PAGE_W - MARGIN, fy - 14);
    font('normal', 8);
    color(MUTED);
    doc.text(`${report.name}${companyName ? `  ·  ${companyName}` : ''}`, MARGIN, fy);
    font('bold', 8);
    color(ACCENT);
    doc.text(`${p} / ${pages}`, PAGE_W - MARGIN, fy, { align: 'right' });
  }

  return doc.output('blob');
}

export function pdfFileName(property, report) {
  const base = `${property.join(' - ') || 'Wet check'} ${report.date} ${report.name}`;
  return base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}
