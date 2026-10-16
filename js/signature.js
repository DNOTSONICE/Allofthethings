// Signature pad. drawSignature() opens #sigpad-dialog, where the signature is either drawn
// with a finger or typed in a handwriting font, and resolves with a PNG Blob (cropped to the
// ink, transparent background), null if cleared, or undefined if cancelled.
// The fonts ship with the app (fonts/), so typing works offline.

import { showDialog } from './ui.js';

const $ = (s) => document.querySelector(s);
const INK = '#14213d';
export const SIGNATURE_FONTS = ['Great Vibes', 'Dancing Script', 'Homemade Apple'];
const STYLE_KEY = 'signatureStyle'; // last typed style picked, remembered on this phone

function rememberStyle(v) {
  try {
    localStorage.setItem(STYLE_KEY, v);
  } catch {}
}
function lastStyle() {
  try {
    return localStorage.getItem(STYLE_KEY) || '';
  } catch {
    return '';
  }
}

export async function drawSignature({ name = '' } = {}) {
  const typed = setUpTyping(name);
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

  typed.done();
  if (answer !== 'ok') return undefined;
  if (typed.active()) {
    const text = $('#sigpad-text').value.trim();
    if (!text) return null;
    rememberStyle(`type:${typed.font()}`);
    return renderTyped(text, typed.font());
  }
  rememberStyle('draw');
  return drawn ? cropToInk(canvas) : null;
}

// The Type tab: a name box and one button per handwriting font, showing the name in it.
function setUpTyping(name) {
  const input = $('#sigpad-text');
  const box = $('#sigpad-styles');
  const last = lastStyle();
  let font = last.startsWith('type:') && SIGNATURE_FONTS.includes(last.slice(5)) ? last.slice(5) : SIGNATURE_FONTS[0];
  let typing = last.startsWith('type:');
  input.value = name;
  const buttons = SIGNATURE_FONTS.map((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sig-style';
    b.style.fontFamily = `'${f}', cursive`;
    b.setAttribute('aria-label', `Signature style ${f}`);
    b.onclick = () => {
      font = f;
      paint();
    };
    return b;
  });
  box.replaceChildren(...buttons);
  const paint = () => {
    const text = input.value.trim() || 'Your name';
    buttons.forEach((b, i) => {
      b.textContent = text;
      b.classList.toggle('on', SIGNATURE_FONTS[i] === font);
    });
  };
  const show = () => {
    $('#sigpad-tab-draw').classList.toggle('on', !typing);
    $('#sigpad-tab-type').classList.toggle('on', typing);
    $('#sigpad-draw').hidden = typing;
    $('#sigpad-type').hidden = !typing;
    $('#sigpad-clear').hidden = typing;
    if (!typing) window.dispatchEvent(new Event('resize')); // the canvas sizes itself once visible
  };
  $('#sigpad-tab-draw').onclick = () => {
    typing = false;
    show();
  };
  $('#sigpad-tab-type').onclick = () => {
    typing = true;
    show();
    input.focus();
  };
  input.oninput = paint;
  paint();
  show();
  return { active: () => typing, font: () => font, done: () => (input.oninput = null) };
}

// The typed name drawn large in the chosen font, as a PNG.
async function renderTyped(text, font) {
  const size = 120;
  const css = `${size}px '${font}'`;
  try {
    await document.fonts.load(css, text);
  } catch {}
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = css;
  const m = ctx.measureText(text);
  c.width = Math.ceil(m.width + size * 0.8);
  c.height = Math.ceil(size * 1.9);
  ctx.font = css;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, size * 0.4, size * 1.25);
  return cropToInk(c);
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
