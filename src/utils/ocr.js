import Tesseract from 'tesseract.js';

let workerCache = null;

export async function getWorker() {
  if (workerCache) return workerCache;
  workerCache = await Tesseract.createWorker(['eng', 'kor']);
  return workerCache;
}

export async function recognizeImage(src, onProgress) {
  const worker = await getWorker();
  if (onProgress) {
    worker.setProgressHandler?.(onProgress);
  }
  const { data } = await worker.recognize(src);
  return data;
}

const SYSTEM_FONTS = [
  { name: 'SF Pro', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 400, style: 'sans-serif' },
  { name: 'SF Pro Bold', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 700, style: 'sans-serif' },
  { name: 'Pretendard', family: 'Pretendard, sans-serif', weight: 500, style: 'sans-serif' },
  { name: 'Pretendard Bold', family: 'Pretendard, sans-serif', weight: 700, style: 'sans-serif' },
  { name: 'Noto Sans KR', family: '"Noto Sans KR", sans-serif', weight: 400, style: 'sans-serif' },
  { name: 'Noto Sans KR Bold', family: '"Noto Sans KR", sans-serif', weight: 700, style: 'sans-serif' },
  { name: 'Helvetica', family: 'Helvetica, Arial, sans-serif', weight: 400, style: 'sans-serif' },
  { name: 'Helvetica Bold', family: 'Helvetica, Arial, sans-serif', weight: 700, style: 'sans-serif' },
  { name: 'Times', family: '"Times New Roman", serif', weight: 400, style: 'serif' },
  { name: 'Courier', family: '"Courier New", monospace', weight: 400, style: 'monospace' },
];

// Naive font matcher: classify text region (serif/sans/mono) + weight from stroke density.
// Returns best-guess font from SYSTEM_FONTS along with estimated size in px.
export function guessFont(word, imageCanvas) {
  if (!word || !word.bbox) return { font: SYSTEM_FONTS[0], size: 14, weight: 400 };
  const { x0, y0, x1, y1 } = word.bbox;
  const height = Math.max(8, y1 - y0);
  // Estimate weight by black pixel density inside bbox
  let weight = 400;
  let style = 'sans-serif';
  try {
    if (imageCanvas) {
      const ctx = imageCanvas.getContext('2d');
      const w = x1 - x0, h = y1 - y0;
      if (w > 1 && h > 1) {
        const data = ctx.getImageData(x0, y0, w, h).data;
        let dark = 0, total = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum < 128) dark++;
          total++;
        }
        const density = dark / total;
        weight = density > 0.28 ? 700 : 400;
      }
    }
  } catch {}
  const wantBold = weight >= 700;
  const isKorean = /[ㄱ-힝]/.test(word.text || '');
  const candidates = SYSTEM_FONTS.filter((f) =>
    isKorean
      ? f.name.includes('Pretendard') || f.name.includes('Noto')
      : f.name.includes('SF') || f.name.includes('Helvetica')
  );
  const match =
    candidates.find((f) => (wantBold ? f.weight >= 700 : f.weight < 700)) || candidates[0] || SYSTEM_FONTS[0];
  return { font: match, size: Math.round(height * 0.9), weight };
}
