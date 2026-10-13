// Shrinks a camera photo before it's saved so the device doesn't fill up.

const MAX_SIDE = 1600; // pixels on the long edge
const QUALITY = 0.72; // JPEG quality

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to <img>, which some older Safari versions need.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Logos keep PNG so transparent backgrounds stay transparent.
export async function compressLogo(file) {
  const png = file.type === 'image/png' || file.type === 'image/svg+xml';
  return compressPhoto(file, { maxSide: 800, type: png ? 'image/png' : 'image/jpeg' });
}

export async function compressPhoto(file, { maxSide = MAX_SIDE, type = 'image/jpeg' } = {}) {
  const img = await decode(file);
  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  if (img.close) img.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not compress photo'))), type, QUALITY);
  });
}
