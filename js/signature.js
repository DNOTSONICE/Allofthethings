// Finger signature pad. drawSignature() opens #sigpad-dialog and resolves with a PNG Blob of
// what was drawn (cropped to the ink, transparent background), null if cleared, or undefined
// if cancelled.

import { showDialog } from './ui.js';

const $ = (s) => document.querySelector(s);
const INK = '#14213d';

export async function drawSignature() {
  const dialog = $('#sigpad-dialog');
  const canvas = $('#sigpad-canvas');
  const ctx = canvas.getContext('2d');
  let drawn = false;
  let last = null;

  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    drawn = false;
    $('#sigpad-hint').hidden = false;
  };
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: e.pressure > 0 && e.pointerType === 'pen' ? 1.2 + e.pressure * 2.4 : 2.6 };
  };
  const down = (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    last = point(e);
    ctx.beginPath();
    ctx.fillStyle = INK;
    ctx.arc(last.x, last.y, last.w / 2, 0, Math.PI * 2);
    ctx.fill();
    drawn = true;
    $('#sigpad-hint').hidden = true;
  };
  const move = (e) => {
    if (!last) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const p = point(ev);
      ctx.lineWidth = p.w;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }
  };
  const up = () => (last = null);

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  const clear = () => size();
  $('#sigpad-clear').addEventListener('click', clear);
  window.addEventListener('resize', size);

  const result = showDialog(dialog);
  size();
  const answer = await result;

  canvas.removeEventListener('pointerdown', down);
  canvas.removeEventListener('pointermove', move);
  canvas.removeEventListener('pointerup', up);
  canvas.removeEventListener('pointercancel', up);
  $('#sigpad-clear').removeEventListener('click', clear);
  window.removeEventListener('resize', size);

  if (answer !== 'ok') return undefined;
  return drawn ? cropToInk(canvas) : null;
}

// The drawing cut down to the ink plus a little margin, as a PNG.
function cropToInk(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return Promise.resolve(null);
  const pad = Math.round(6 * (window.devicePixelRatio || 1));
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'));
}
