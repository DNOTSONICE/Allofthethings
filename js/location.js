// Where and when a photo was taken: GPS from the phone or the photo's own EXIF data,
// plus the city name, looked up when there's a connection.

// Resolves with { lat, lon, accuracy } or null if location is off, denied or too slow.
export function getPosition(timeoutMs = 15000) {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 }
    );
  });
}

// ---------- EXIF ----------

// Reads capture time and GPS from a JPEG's EXIF block. Resolves with
// { takenAt?, lat?, lon? }, or {} for photos without it (or non-JPEGs).
export async function readExif(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    return parseExif(new DataView(buf));
  } catch {
    return {};
  }
}

function parseExif(view) {
  if (view.getUint16(0) !== 0xffd8) return {};
  let pos = 2;
  while (pos + 4 < view.byteLength) {
    const marker = view.getUint16(pos);
    const size = view.getUint16(pos + 2);
    // APP1 segment starting with "Exif\0\0"
    if (marker === 0xffe1 && view.getUint32(pos + 4) === 0x45786966) return parseTiff(view, pos + 10);
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // start of image data
    pos += 2 + size;
  }
  return {};
}

function parseTiff(view, start) {
  const little = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, little);
  const u32 = (o) => view.getUint32(start + o, little);

  function readIfd(offset) {
    const tags = {};
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const valueAt = (type === 2 && n <= 4) || (type === 3 && n <= 2) || (type === 4 && n <= 1) ? e + 8 : u32(e + 8);
      if (type === 2) {
        let s = '';
        for (let k = 0; k < n - 1; k++) s += String.fromCharCode(view.getUint8(start + valueAt + k));
        tags[tag] = s;
      } else if (type === 3) tags[tag] = u16(valueAt);
      else if (type === 4) tags[tag] = u32(valueAt);
      else if (type === 5) {
        const vals = [];
        for (let k = 0; k < n; k++) vals.push(u32(valueAt + k * 8) / u32(valueAt + k * 8 + 4));
        tags[tag] = vals;
      }
    }
    return tags;
  }

  const out = {};
  const ifd0 = readIfd(u32(4));

  if (ifd0[0x8769]) {
    const exif = readIfd(ifd0[0x8769]);
    const m = (exif[0x9003] || '').match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m) out.takenAt = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); // camera's local time
  }

  if (ifd0[0x8825]) {
    const gps = readIfd(ifd0[0x8825]);
    const deg = (v) => v[0] + v[1] / 60 + v[2] / 3600;
    if (Array.isArray(gps[2]) && Array.isArray(gps[4])) {
      const lat = deg(gps[2]) * (gps[1] === 'S' ? -1 : 1);
      const lon = deg(gps[4]) * (gps[3] === 'W' ? -1 : 1);
      if (isFinite(lat) && isFinite(lon) && (lat || lon)) {
        out.lat = lat;
        out.lon = lon;
      }
    }
  }
  return out;
}

// ---------- City lookup ----------

// Resolves with a place name like "Austin, TX", or null when offline or not found.
export async function lookupCity(lat, lon) {
  if (!navigator.onLine) return null;
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    const city = d.city || d.locality;
    const region = (d.principalSubdivisionCode || '').split('-')[1] || d.principalSubdivision;
    return [city, region].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

// ---------- Display ----------

// "33.44838, -112.07404": the format map apps accept when pasted into search.
export function coordsText(stamp) {
  return `${stamp.lat.toFixed(5)}, ${stamp.lon.toFixed(5)}`;
}

// Opens the spot in Apple Maps on iPhone/iPad/Mac and Google Maps elsewhere.
export function mapUrl(stamp) {
  const q = `${stamp.lat.toFixed(6)},${stamp.lon.toFixed(6)}`;
  return /iPhone|iPad|Macintosh/.test(navigator.userAgent)
    ? `https://maps.apple.com/?ll=${q}&q=${q}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export function formatTime(ms) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Smaller details under the coordinates: city, accuracy, time taken.
export function stampDetails(stamp) {
  if (!stamp) return '';
  const parts = [];
  if (stamp.city) parts.push(stamp.city);
  if (stamp.accuracy) parts.push(`±${stamp.accuracy} m`);
  if (stamp.takenAt) parts.push(formatTime(stamp.takenAt));
  return parts.join(' · ');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: copy through a temporary text box.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
