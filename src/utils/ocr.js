import Tesseract from 'tesseract.js';

let workerCache = null;

export async function getWorker() {
  if (workerCache) return workerCache;
  workerCache = await Tesseract.createWorker(['kor', 'eng']);
  // PSM 6 = uniform block of text — works much better on UI screenshots / mockups
  // than the default auto (which tends to skip parts of Korean syllable blocks).
  try {
    await workerCache.setParameters({ tessedit_pageseg_mode: '6' });
  } catch {}
  return workerCache;
}

export async function recognizeImage(src, onProgress) {
  const worker = await getWorker();
  if (onProgress) worker.setProgressHandler?.(onProgress);
  const { data } = await worker.recognize(src);
  return data;
}

// Canonical font set — also used to populate dropdowns and font preloads.
export const SYSTEM_FONTS = [
  // Korean-first sans
  { name: 'Pretendard', family: 'Pretendard, -apple-system, sans-serif', weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Pretendard Medium', family: 'Pretendard, -apple-system, sans-serif', weight: 500, kind: 'sans', script: 'ko' },
  { name: 'Pretendard SemiBold', family: 'Pretendard, -apple-system, sans-serif', weight: 600, kind: 'sans', script: 'ko' },
  { name: 'Pretendard Bold', family: 'Pretendard, -apple-system, sans-serif', weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR', family: '"Noto Sans KR", sans-serif', weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR Medium', family: '"Noto Sans KR", sans-serif', weight: 500, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR Bold', family: '"Noto Sans KR", sans-serif', weight: 700, kind: 'sans', script: 'ko' },
  // Latin sans
  { name: 'SF Pro', family: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif', weight: 400, kind: 'sans', script: 'lat' },
  { name: 'SF Pro Bold', family: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif', weight: 700, kind: 'sans', script: 'lat' },
  { name: 'Helvetica', family: 'Helvetica, Arial, sans-serif', weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Helvetica Bold', family: 'Helvetica, Arial, sans-serif', weight: 700, kind: 'sans', script: 'lat' },
  // Serif
  { name: 'Georgia', family: 'Georgia, "Times New Roman", serif', weight: 400, kind: 'serif' },
  { name: 'Georgia Bold', family: 'Georgia, "Times New Roman", serif', weight: 700, kind: 'serif' },
  { name: 'Times', family: '"Times New Roman", Times, serif', weight: 400, kind: 'serif' },
  // Mono
  { name: 'Courier', family: '"Courier New", Courier, monospace', weight: 400, kind: 'mono' },
];

function findFont({ kind, script, weight }) {
  const wantBold = weight >= 600;
  // Score by kind/script/weight match
  let best = SYSTEM_FONTS[0], bestScore = -1;
  for (const f of SYSTEM_FONTS) {
    let s = 0;
    if (kind && f.kind === kind) s += 3;
    if (script && f.script === script) s += 2;
    if (wantBold && f.weight >= 600) s += 2;
    if (!wantBold && f.weight < 600) s += 2;
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return best;
}

// Font matcher using Tesseract word metadata when present, plus pixel-density fallback.
// Returns { font, size, weight } where font = { name, family, weight }.
export function guessFont(word, imageCanvas) {
  if (!word || !word.bbox) return { font: SYSTEM_FONTS[0], size: 14, weight: 400 };
  const { x0, y0, x1, y1 } = word.bbox;
  const height = Math.max(8, y1 - y0);
  const text = word.text || '';
  const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);

  // Read Tesseract-provided font hints when available.
  let isBold = !!word.is_bold;
  let isSerif = !!word.is_serif;
  let isMono = !!word.is_monospace;

  // Heuristic boldness from black-pixel density (covers cases where Tesseract omits the flag).
  if (!isBold) {
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
          if (dark / total > 0.30) isBold = true;
        }
      }
    } catch {}
  }

  const kind = isMono ? 'mono' : isSerif ? 'serif' : 'sans';
  const script = isKorean ? 'ko' : 'lat';
  const weight = isBold ? 700 : 400;
  const match = findFont({ kind, script, weight });

  // Prefer Tesseract font_size when reasonable; otherwise derive from bbox height.
  const tsize = Number(word.font_size);
  const size =
    tsize && tsize >= 8 && tsize <= 200
      ? Math.round(tsize)
      : Math.round(height * (isKorean ? 0.88 : 0.78));

  return { font: match, size, weight };
}
