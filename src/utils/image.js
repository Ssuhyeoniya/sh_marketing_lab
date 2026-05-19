export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

export async function fileToDataURL(file) {
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
}

// Resize source image so its WIDTH is exactly `targetWidth`. Height scales proportionally.
// If the source is smaller, it is upscaled to targetWidth as well.
export async function resizeToWidth(src, targetWidth = 512) {
  const img = typeof src === 'string' ? await loadImage(src) : src;
  const ratio = targetWidth / img.naturalWidth;
  const w = targetWidth;
  const h = Math.round(img.naturalHeight * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

// Crop image canvas to specified rect.
export function cropCanvas(canvas, x, y, w, h) {
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

export function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}
