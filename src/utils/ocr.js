import Tesseract from 'tesseract.js';

let workerCache = null;

export async function getWorker() {
  if (workerCache) return workerCache;
  workerCache = await Tesseract.createWorker(['kor', 'eng']);
  // Wider language coverage:
  //   - PSM 6 (uniform block) is the most reliable on document scans /
  //     screenshots. PSM 11 (sparse text) is better for tables but loses
  //     line grouping; we stick with 6 and pre-process the image to remove
  //     table rules so cells get treated as normal text blocks.
  //   - preserve_interword_spaces=1 makes Tesseract emit a SPACE between
  //     adjacent words even when the gap is small; without this, Korean
  //     mixed with Latin/numerics often collapses into one token.
  //   - tessedit_char_blacklist left empty (we want every glyph).
  try {
    await workerCache.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
  } catch {}
  return workerCache;
}

export async function recognizeImage(src, onProgress) {
  const worker = await getWorker();
  if (onProgress) worker.setProgressHandler?.(onProgress);
  const { data } = await worker.recognize(src);
  return data;
}

// Image preprocessing for OCR. Returns a NEW canvas with:
//   - 2× upscaling if the source DPI looks small (heuristic: width < 1800),
//     using a multi-step (bicubic-equivalent) draw so glyph edges stay
//     reasonably clean. Tesseract is tuned for ~300 DPI document scans;
//     low-DPI inputs produce mushy edges and break Korean glyph
//     recognition first.
//   - Mild luminance sharpen: pulls anti-aliased glyph edges back toward
//     pure-dark so the adaptive classifier doesn't dither into the
//     background. Implemented via a 3×3 unsharp mask applied only to dark
//     pixels (so coloured backgrounds and graphics aren't crunched).
//   - Soft denoise on near-background pixels: anything within 12 luminance
//     units of the local row median snaps to white. Removes JPEG ringing
//     around small Korean glyphs without erasing real strokes.
// Bypasses entirely (returns the source canvas as-is) when:
//   - canvas is already very large (≥ 2400 px wide),
//   - or any single dimension is so large that allocating the 2× target
//     would blow past a sensible 30 megapixel ceiling.
export function preprocessForOcr(srcCanvas, opts = {}) {
  const upscaleThreshold = opts.upscaleThreshold ?? 1800;
  const maxPixels = opts.maxPixels ?? 30 * 1024 * 1024; // ~30 MP target cap
  try {
    const srcW = srcCanvas.width, srcH = srcCanvas.height;
    let scale = srcW < upscaleThreshold ? 2 : 1;
    if (srcW * srcH * scale * scale > maxPixels) scale = 1;
    const tgtW = srcW * scale, tgtH = srcH * scale;

    // Upscale to an intermediate canvas. `imageSmoothingQuality = "high"`
    // is bicubic-like in Chromium/Safari/Firefox, which is what we want
    // for text — bilinear leaves diagonal strokes serrated.
    const big = document.createElement('canvas');
    big.width = tgtW;
    big.height = tgtH;
    const bctx = big.getContext('2d');
    if (scale > 1) {
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
    }
    bctx.drawImage(srcCanvas, 0, 0, tgtW, tgtH);

    // Sharpen + denoise in one pass over the pixel buffer. We avoid a full
    // convolution kernel (slow on a 2× upscaled page) by doing per-pixel
    // contrast stretching against a row-local background estimate.
    const img = bctx.getImageData(0, 0, tgtW, tgtH);
    const data = img.data;
    // Row-local bg estimate: mean luminance of every 16th pixel per row.
    // Cheap O(W*H/16). Robust enough for documents — pages with mixed
    // light/dark regions still get a usable per-row baseline.
    const stride = 16;
    for (let y = 0; y < tgtH; y++) {
      let sum = 0, cnt = 0;
      const rowOff = y * tgtW * 4;
      for (let x = 0; x < tgtW; x += stride) {
        const i = rowOff + x * 4;
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        cnt++;
      }
      const rowBg = cnt ? sum / cnt : 240;
      // Snap-to-white margin: how close to bg a pixel must be to be
      // considered noise. 12/255 ≈ 5 % luminance — well below the
      // contrast of real anti-aliased glyph edges.
      const denoiseMargin = 12;
      // Sharpen factor: pull dark pixels darker, bright pixels brighter.
      // Applied softly (0.4) so coloured text / graphics aren't crushed.
      const sharpen = 0.4;
      for (let x = 0; x < tgtW; x++) {
        const i = rowOff + x * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (Math.abs(lum - rowBg) < denoiseMargin) {
          // Near-background noise → snap to white-ish (use rowBg so
          // coloured backgrounds stay their colour).
          data[i]   = Math.min(255, Math.round(rowBg));
          data[i+1] = Math.min(255, Math.round(rowBg));
          data[i+2] = Math.min(255, Math.round(rowBg));
        } else if (lum < rowBg) {
          // Dark pixel — sharpen toward black.
          data[i]   = Math.max(0, data[i]   - Math.round(sharpen * (rowBg - lum)));
          data[i+1] = Math.max(0, data[i+1] - Math.round(sharpen * (rowBg - lum)));
          data[i+2] = Math.max(0, data[i+2] - Math.round(sharpen * (rowBg - lum)));
        }
      }
    }
    bctx.putImageData(img, 0, 0);
    return big;
  } catch {
    return srcCanvas;
  }
}

// Garbage-text detector for PDF text-layer extraction.
//
// pdfjs's `getTextContent()` returns the Unicode string for each text
// item — but only if the PDF's font carries a usable ToUnicode CMap. CJK
// PDFs commonly subset their fonts and map glyphs to Private Use Area
// (PUA) codepoints with no real Unicode mapping; pdfjs then falls back
// to glyph names that decode as random Latin sequences, producing
// strings like "ATE 2개월 peuED 됩니다" where parts of the Korean text
// got mangled into mid-word case-mixed Latin clusters.
//
// We can't detect this from the codepoints alone (PUA chars look the
// same as legit Korean), but the output patterns are distinctive:
//   1) Latin tokens with impossible capitalisation in a Korean context
//      ("peuED", "AbcDEF") — real words / acronyms never look like this.
//   2) Long Hangul runs with no spaces and no common grammatical
//      particles ("c덕타커리젓짚전첫돌") — real Korean prose breaks every
//      few characters with a particle (은/는/이/가/을/를/의/에/도/와/과/에서/
//      으로/로/까지/부터/만/처럼/보다) or whitespace.
//
// Returns true when the string looks corrupted. False = trust it.
export function looksGarbledKorean(s) {
  if (!s) return false;
  const text = String(s);
  const hangulMatches = text.match(/[가-힣]/g);
  if (!hangulMatches || hangulMatches.length === 0) return false;
  // Recognised acronyms / units that legitimately appear mid-Korean — these
  // are NOT garble signals when they show up as short uppercase Latin tokens.
  const ALLOWED_UPPER = new Set([
    'AI', 'AR', 'VR', 'IT', 'OS', 'PC', 'TV', 'PD', 'CD', 'DVD', 'USB',
    'HD', 'FHD', 'UHD', '4K', '8K', 'OK', 'KO', 'EN', 'KR', 'US', 'EU',
    'PDF', 'JPG', 'PNG', 'GIF', 'CEO', 'CTO', 'CFO', 'CMO', 'API', 'SDK',
    'SUV', 'GPS', 'LED', 'LCD', 'OLED', 'IOS', 'IOT', 'SSD', 'HDD', 'CPU',
    'GPU', 'RAM', 'ROM', 'MP3', 'MP4', 'KBS', 'MBC', 'SBS', 'YTN', 'JTBC',
    'NASA', 'NATO', 'IMF', 'UN', 'UNDP', 'WHO', 'CCTV', 'KTX', 'SRT',
    'BTS', 'SK', 'LG', 'KT', 'GS', 'CJ', 'SM', 'YG', 'JYP', 'EXO',
    'BMW', 'KIA', 'EV', 'NFC',
  ]);
  // 1) Latin-token capitalisation check (catches pdfjs glyph-name fallbacks).
  const tokens = text.split(/[\s,.()[\]{}<>"'/\\:;!?·•|\-_]+/);
  let upperTokensInKorean = 0;
  for (const t of tokens) {
    if (!t || t.length < 2) continue;
    if (!/^[A-Za-z]+$/.test(t)) continue;
    const isAllLower   = /^[a-z]+$/.test(t);
    const isAllUpper   = /^[A-Z]+$/.test(t);
    const isCamelCase  = /^[a-z]+(?:[A-Z][a-z]+)+$/.test(t);
    const isPascalCase = /^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(t);
    // Short uppercase tokens (2-4 chars) embedded mid-Korean are a classic
    // garble pattern — pdfjs's PUA fallback decodes a CJK glyph as a 3-4
    // letter all-caps "name". Allow only recognised acronyms.
    if (isAllUpper && t.length >= 2 && t.length <= 4 && !ALLOWED_UPPER.has(t)) {
      upperTokensInKorean++;
      // Two or more unknown uppercase tokens = almost certainly garbled.
      if (upperTokensInKorean >= 2) return true;
      // Even a single unknown short uppercase token, when the Korean
      // proportion is high, is a strong signal.
      if (hangulMatches.length >= 3) return true;
    }
    if (isAllLower || isAllUpper || isCamelCase || isPascalCase) continue;
    return true;
  }
  // 2) Long-Hangul-run-without-grammar check (catches PUA Hangul where
  //    pdfjs returned valid-looking but random Hangul codepoints).
  //    A run of ≥ 6 hangul chars with NO whitespace AND NO common particle
  //    is almost certainly garbage — real prose / labels at that length
  //    always contain at least one particle.
  const particleRe = /[은는이가을를의에도와과로으]|에서|으로|까지|부터|처럼|보다|에게|에서|에는/;
  const hangulRuns = text.match(/[가-힣]{6,}/g) || [];
  for (const run of hangulRuns) {
    if (!particleRe.test(run)) return true;
  }
  // 3) Hangul + Latin lone-letter mix without spacing
  //    ("c덕타커리젓짚전첫돌" — lone "c" stuck to a Hangul run).
  if (/[A-Za-z][가-힣]|[가-힣][A-Za-z]/.test(text)) {
    // Allow ONLY when the Latin segment is a recognisable acronym /
    // version-like token at a token boundary. The above regex fired on a
    // direct alpha↔hangul transition with no whitespace, which is a strong
    // garble signal — even "PDF편집" would trigger, so we additionally
    // require the Hangul side to be ≥ 3 chars (to skip short labels like
    // "PDF용") AND the Latin side to be lowercase mid-string (uppercase
    // acronyms touching Hangul are fine: "AI기반").
    if (/[a-z][가-힣]{3,}|[가-힣]{3,}[a-z]/.test(text)) return true;
  }
  return false;
}

// Aggregate quality assessment for a page's worth of pdfjs text items.
// Returns:
//   { trusted: boolean, garbledCount, total, ratio }
// `trusted = false` when ≥ 15 % of items look garbled — at that point
// the page's whole text layer is unreliable and the caller should fall
// back to running OCR on the rasterised page bitmap.
export function assessPdfTextQuality(items) {
  const list = Array.isArray(items) ? items : [];
  let garbled = 0;
  let total = 0;
  for (const it of list) {
    const t = (it?.text ?? it?.str ?? '').trim();
    if (!t) continue;
    total++;
    if (looksGarbledKorean(t)) garbled++;
  }
  const ratio = total ? garbled / total : 0;
  return {
    // Aggressively bail on suspect PDFs: even a small fraction of garbled
    // items means a meaningful chunk of the page is unreadable in the
    // editor — and worse, the garble usually concentrates in the most
    // editable text (body / table cells). OCR fallback is cheap relative
    // to showing nonsense layers like "ATE 2개월 단위 EES 됩니다".
    trusted: ratio < 0.05,
    garbledCount: garbled,
    total,
    ratio,
  };
}

// Detect long, thin runs of dark pixels (table borders) and paint over them
// with the local background colour so OCR isn't disrupted by ruled lines
// crossing or hugging glyphs. Returns a NEW canvas — original untouched so
// colour sampling for final rendering still uses the real pixels.
export function suppressTableLines(srcCanvas, opts = {}) {
  const minLen = opts.minLen ?? Math.min(srcCanvas.width, srcCanvas.height) * 0.15;
  const maxThickness = opts.maxThickness ?? 3;
  const darkThr = opts.darkThr ?? 110; // mean luminance threshold for "dark"
  try {
    const out = document.createElement('canvas');
    out.width = srcCanvas.width;
    out.height = srcCanvas.height;
    const sctx = srcCanvas.getContext('2d');
    const octx = out.getContext('2d');
    octx.drawImage(srcCanvas, 0, 0);
    const W = srcCanvas.width, H = srcCanvas.height;
    const img = sctx.getImageData(0, 0, W, H);
    const data = img.data;
    // Per-row longest dark-pixel run length.
    const rowDarkRun = new Array(H).fill(0);
    for (let y = 0; y < H; y++) {
      let run = 0, maxRun = 0;
      const rowStart = y * W * 4;
      for (let x = 0; x < W; x++) {
        const i = rowStart + x * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (lum < darkThr) { run++; if (run > maxRun) maxRun = run; }
        else run = 0;
      }
      rowDarkRun[y] = maxRun;
    }

    octx.fillStyle = '#ffffff';
    // Mask HORIZONTAL rules first. Vertical rules are addressed below with a
    // narrower predicate so we don't accidentally erase column rules that
    // Tesseract relies on to keep adjacent cells separate — only short,
    // isolated vertical strokes that pierce glyph rows get cleaned.
    for (let y = 0; y < H; y++) {
      if (rowDarkRun[y] < minLen) continue;
      let thickness = 1;
      for (let dy = 1; dy <= maxThickness + 1 && y + dy < H; dy++) {
        if (rowDarkRun[y + dy] >= minLen * 0.7) thickness++;
        else break;
      }
      if (thickness <= maxThickness) {
        octx.fillRect(0, Math.max(0, y - 1), W, thickness + 2);
        y += thickness;
      }
    }
    // Per-column longest dark-pixel run length, recomputed from the original
    // image. We only suppress a column-line segment if it's SHORT (well below
    // page height) — i.e. an in-cell border that crosses one glyph row. Full
    // table column rules (≥ 40 % of page height) are preserved as Tesseract
    // line/cell separators.
    const minColLen = opts.minColLen ?? Math.max(20, Math.round(H * 0.04));
    const maxColLen = opts.maxColLen ?? Math.round(H * 0.30);
    for (let x = 0; x < W; x++) {
      let run = 0;
      let runStart = 0;
      for (let y = 0; y <= H; y++) {
        const isDark = y < H && (() => {
          const i = (y * W + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          return lum < darkThr;
        })();
        if (isDark) {
          if (run === 0) runStart = y;
          run++;
        } else if (run > 0) {
          // Commit the previous run if it's a thin in-cell vertical (length
          // between minColLen and maxColLen). Anything taller is treated as
          // a column rule and left alone.
          if (run >= minColLen && run <= maxColLen) {
            // Verify thickness ≤ maxThickness by checking neighbouring cols.
            let thickness = 1;
            for (let dx = 1; dx <= maxThickness + 1 && x + dx < W; dx++) {
              // Sample the midpoint of the run in the neighbour column.
              const my = runStart + (run >> 1);
              const ni = (my * W + (x + dx)) * 4;
              const lum = 0.299 * data[ni] + 0.587 * data[ni + 1] + 0.114 * data[ni + 2];
              if (lum < darkThr) thickness++;
              else break;
            }
            if (thickness <= maxThickness) {
              octx.fillRect(Math.max(0, x - 1), runStart, thickness + 2, run);
            }
          }
          run = 0;
        }
      }
    }
    return out;
  } catch {
    return srcCanvas;
  }
}

// Tighten a bbox to the actual glyph ink. OCR (and PDF text items) report
// bounding boxes that often include 10–30 % vertical padding above and below
// the visible glyph — line spacing, descender slack, Tesseract's adaptive
// box, etc. We scan pixels inside the bbox, find the local background
// luminance from the corners, and crop the rect to the min/max x/y where
// dark pixels live.
//
// Returns { x0, y0, x1, y1, baseY } in canvas pixels. baseY is the bottom of
// the ink (true baseline approximation when descenders are absent — e.g. for
// Korean text and most Latin text without g/p/q/y). The original bbox is
// returned unchanged when:
//   - the bbox is degenerate (< 4 px in either dim),
//   - no ink is found (transparent / empty cell),
//   - or the background sample is itself dark (likely a dark-on-light
//     reverse layout where corner sampling fails — keep original to be safe).
export function tightenBBoxToGlyphs(canvas, bbox, opts = {}) {
  const pad = opts.pad ?? 1;
  const minRetain = opts.minRetain ?? 0.4; // refuse to shrink below 40 % h
  try {
    const w = bbox.x1 - bbox.x0;
    const h = bbox.y1 - bbox.y0;
    if (w < 4 || h < 4) return null;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(bbox.x0, bbox.y0, w, h);
    const data = img.data;
    // Sample background from the four corner 2×2 patches (median luminance).
    const cornerLums = [];
    const samplePatch = (cx, cy) => {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = Math.max(0, Math.min(w - 1, cx + dx));
          const y = Math.max(0, Math.min(h - 1, cy + dy));
          const i = (y * w + x) * 4;
          cornerLums.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }
      }
    };
    samplePatch(0, 0);
    samplePatch(w - 2, 0);
    samplePatch(0, h - 2);
    samplePatch(w - 2, h - 2);
    cornerLums.sort((a, b) => a - b);
    const bgLum = cornerLums[Math.floor(cornerLums.length / 2)];
    // Dark-pixel test relative to the local background. The 40-unit margin
    // (luminance scale 0–255) sits well above JPEG/PNG noise but still
    // catches faint anti-aliased glyph edges.
    const margin = 40;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const rowStart = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = rowStart + x * 4;
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (Math.abs(lum - bgLum) > margin) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // empty
    // Sanity: refuse to shrink height below `minRetain` × original — protects
    // against degenerate scans of low-contrast glyphs where we'd otherwise
    // collapse the box to just the darkest few pixels.
    const tightH = maxY - minY + 1;
    if (tightH < h * minRetain) return null;
    return {
      x0: Math.max(0, bbox.x0 + minX - pad),
      y0: Math.max(0, bbox.y0 + minY - pad),
      x1: Math.min(canvas.width, bbox.x0 + maxX + 1 + pad),
      y1: Math.min(canvas.height, bbox.y0 + maxY + 1 + pad),
      baseY: bbox.y0 + maxY + 1,    // ink-bottom — best baseline proxy w/o descenders
      glyphTop: bbox.y0 + minY,
    };
  } catch {
    return null;
  }
}

// Decide whether a bbox holds VERTICALLY-stacked text. Heuristic:
//   - aspect = w / h < 0.6 (taller than wide)
//   - text contains ≥ 2 characters (single glyphs aren't "vertical" on their own)
//   - mean inter-row ink gap < 30 % of the bbox width (rows are roughly square
//     stacked glyphs, not a single tall character like a logo)
// Returns `true` when the cell should be flagged as 90°-rotated. We deliberately
// don't try to RE-rotate the underlying OCR result here — Tesseract already gives
// us per-glyph data; the rotation flag lets the editor render the synthesised
// edit-layer with `angleDeg: -90` so typing matches the original orientation.
export function detectVerticalText(canvas, bbox, text) {
  try {
    const w = bbox.x1 - bbox.x0;
    const h = bbox.y1 - bbox.y0;
    if (w < 4 || h < 12) return false;
    if (w / h >= 0.6) return false;
    if (!text || text.replace(/\s+/g, '').length < 2) return false;
    return true;
  } catch {
    return false;
  }
}


// Canonical font set — also used to populate dropdowns and font preloads.
// Generic-family fallbacks are appended so glyph widths stay close to the
// chosen face even when the web font hasn't loaded yet on slower networks.
export const SYSTEM_FONTS = [
  // ── Korean sans (free, broadly available) ──────────────────────────────────
  { name: 'Pretendard',           family: 'Pretendard, -apple-system, sans-serif',               weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Pretendard Medium',    family: 'Pretendard, -apple-system, sans-serif',               weight: 500, kind: 'sans', script: 'ko' },
  { name: 'Pretendard SemiBold',  family: 'Pretendard, -apple-system, sans-serif',               weight: 600, kind: 'sans', script: 'ko' },
  { name: 'Pretendard Bold',      family: 'Pretendard, -apple-system, sans-serif',               weight: 700, kind: 'sans', script: 'ko' },
  { name: 'SUIT',                 family: 'SUIT, Pretendard, sans-serif',                        weight: 400, kind: 'sans', script: 'ko' },
  { name: 'SUIT Medium',          family: 'SUIT, Pretendard, sans-serif',                        weight: 500, kind: 'sans', script: 'ko' },
  { name: 'SUIT Bold',            family: 'SUIT, Pretendard, sans-serif',                        weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR',         family: '"Noto Sans KR", sans-serif',                          weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR Medium',  family: '"Noto Sans KR", sans-serif',                          weight: 500, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR Bold',    family: '"Noto Sans KR", sans-serif',                          weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Noto Sans KR Black',   family: '"Noto Sans KR", sans-serif',                          weight: 900, kind: 'sans', script: 'ko' },
  { name: 'Nanum Gothic',         family: '"Nanum Gothic", "Noto Sans KR", sans-serif',          weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Nanum Gothic Bold',    family: '"Nanum Gothic", "Noto Sans KR", sans-serif',          weight: 700, kind: 'sans', script: 'ko' },
  { name: 'IBM Plex Sans KR',     family: '"IBM Plex Sans KR", "Noto Sans KR", sans-serif',      weight: 400, kind: 'sans', script: 'ko' },
  { name: 'IBM Plex Sans KR Bold',family: '"IBM Plex Sans KR", "Noto Sans KR", sans-serif',      weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Gothic A1',            family: '"Gothic A1", "Noto Sans KR", sans-serif',             weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Gothic A1 Bold',       family: '"Gothic A1", "Noto Sans KR", sans-serif',             weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Gowun Dodum',          family: '"Gowun Dodum", "Noto Sans KR", sans-serif',           weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Black Han Sans',       family: '"Black Han Sans", "Noto Sans KR", sans-serif',        weight: 700, kind: 'sans', script: 'ko' },
  { name: 'Do Hyeon',             family: '"Do Hyeon", "Noto Sans KR", sans-serif',              weight: 400, kind: 'sans', script: 'ko' },
  { name: 'Jua',                  family: '"Jua", "Noto Sans KR", sans-serif',                   weight: 400, kind: 'sans', script: 'ko' },
  // ── Korean serif ───────────────────────────────────────────────────────────
  { name: 'Noto Serif KR',        family: '"Noto Serif KR", serif',                              weight: 400, kind: 'serif', script: 'ko' },
  { name: 'Noto Serif KR Bold',   family: '"Noto Serif KR", serif',                              weight: 700, kind: 'serif', script: 'ko' },
  { name: 'Nanum Myeongjo',       family: '"Nanum Myeongjo", "Noto Serif KR", serif',            weight: 400, kind: 'serif', script: 'ko' },
  { name: 'Nanum Myeongjo Bold',  family: '"Nanum Myeongjo", "Noto Serif KR", serif',            weight: 700, kind: 'serif', script: 'ko' },
  { name: 'Hahmlet',              family: '"Hahmlet", "Noto Serif KR", serif',                   weight: 400, kind: 'serif', script: 'ko' },
  // ── Latin sans ─────────────────────────────────────────────────────────────
  { name: 'Inter',                family: 'Inter, -apple-system, sans-serif',                    weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Inter Medium',         family: 'Inter, -apple-system, sans-serif',                    weight: 500, kind: 'sans', script: 'lat' },
  { name: 'Inter Bold',           family: 'Inter, -apple-system, sans-serif',                    weight: 700, kind: 'sans', script: 'lat' },
  { name: 'Roboto',               family: 'Roboto, "Helvetica Neue", Arial, sans-serif',         weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Roboto Medium',        family: 'Roboto, "Helvetica Neue", Arial, sans-serif',         weight: 500, kind: 'sans', script: 'lat' },
  { name: 'Roboto Bold',          family: 'Roboto, "Helvetica Neue", Arial, sans-serif',         weight: 700, kind: 'sans', script: 'lat' },
  { name: 'IBM Plex Sans',        family: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',weight: 400, kind: 'sans', script: 'lat' },
  { name: 'IBM Plex Sans Bold',   family: '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif',weight: 700, kind: 'sans', script: 'lat' },
  { name: 'Source Sans 3',        family: '"Source Sans 3", "Helvetica Neue", Arial, sans-serif',weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Lato',                 family: 'Lato, "Helvetica Neue", Arial, sans-serif',           weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Open Sans',            family: '"Open Sans", "Helvetica Neue", Arial, sans-serif',    weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Montserrat',           family: 'Montserrat, "Helvetica Neue", Arial, sans-serif',     weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Poppins',              family: 'Poppins, "Helvetica Neue", Arial, sans-serif',        weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Helvetica',            family: 'Helvetica, Arial, sans-serif',                        weight: 400, kind: 'sans', script: 'lat' },
  { name: 'Helvetica Bold',       family: 'Helvetica, Arial, sans-serif',                        weight: 700, kind: 'sans', script: 'lat' },
  { name: 'Arial',                family: 'Arial, "Helvetica Neue", sans-serif',                 weight: 400, kind: 'sans', script: 'lat' },
  // ── Latin serif ────────────────────────────────────────────────────────────
  { name: 'IBM Plex Serif',       family: '"IBM Plex Serif", Georgia, serif',                    weight: 400, kind: 'serif', script: 'lat' },
  { name: 'Source Serif 4',       family: '"Source Serif 4", Georgia, serif',                    weight: 400, kind: 'serif', script: 'lat' },
  { name: 'Merriweather',         family: 'Merriweather, Georgia, serif',                        weight: 400, kind: 'serif', script: 'lat' },
  { name: 'Georgia',              family: 'Georgia, "Times New Roman", serif',                   weight: 400, kind: 'serif' },
  { name: 'Georgia Bold',         family: 'Georgia, "Times New Roman", serif',                   weight: 700, kind: 'serif' },
  { name: 'Times',                family: '"Times New Roman", Times, serif',                     weight: 400, kind: 'serif' },
  // ── Mono ───────────────────────────────────────────────────────────────────
  { name: 'IBM Plex Mono',        family: '"IBM Plex Mono", "Courier New", monospace',           weight: 400, kind: 'mono' },
  { name: 'JetBrains Mono',       family: '"JetBrains Mono", "Courier New", monospace',          weight: 400, kind: 'mono' },
  { name: 'Courier',              family: '"Courier New", Courier, monospace',                   weight: 400, kind: 'mono' },
];

// Diversified font picker. Previously every Korean sans line landed on
// "Pretendard" because it was first in SYSTEM_FONTS and tied on score.
// We now break ties using visual signals:
//   - strokeRatio  : 0–1, dark-pixel-stroke / glyph-height. > 0.20 = ultra
//                    bold, < 0.08 = thin.
//   - fontSizePx   : rough size proxy. ≥ 38 px = title / display.
//   - aspectRatio  : bbox w/h. Very wide-letter aspect → display fonts.
//   - opts.tieKey  : a stable integer (e.g. a hash of the layer text) used
//                    only to round-robin among truly equal candidates so
//                    different lines get different faces.
function findFont({ kind, script, weight, preferBoldName = false, strokeRatio = 0, fontSizePx = 0, tieKey = 0 }) {
  const wantBold = weight >= 600;
  const isDisplay = fontSizePx >= 38;
  const isThin = !wantBold && strokeRatio > 0 && strokeRatio < 0.085;
  const isUltra = wantBold && strokeRatio > 0.20;

  const scored = SYSTEM_FONTS.map((f, idx) => {
    let s = 0;
    if (kind && f.kind === kind) s += 4;
    else if (kind === 'sans' && f.kind === 'serif') s -= 4;
    if (script && f.script === script) s += 3;
    else if (!f.script) s += 1;
    else if (script === 'ko' && f.script === 'lat') s -= 6;
    if (wantBold) {
      if (f.weight >= 700) s += 3;
      else if (f.weight >= 600) s += 2;
      else s -= 2;
      if (preferBoldName && /\bbold|black|heavy\b/i.test(f.name)) s += 2;
    } else {
      if (f.weight >= 600) s -= 2;
      else s += 2;
    }
    // Display-font preference for big stylised titles. Black Han Sans,
    // Do Hyeon, Jua, and Hahmlet are quite distinct from body Pretendard.
    if (isDisplay && /Black Han Sans|Do Hyeon|Jua|Hahmlet|Pretendard Bold|Noto Sans KR Black/i.test(f.name)) {
      s += 2;
    }
    // Ultra-thick strokes → Black Han Sans
    if (isUltra && /Black Han Sans/i.test(f.name)) s += 4;
    // Very thin → SUIT / IBM Plex Sans KR (both have lighter feel)
    if (isThin && /SUIT(?!.*Bold)|IBM Plex Sans KR(?!.*Bold)|Noto Sans KR Light/i.test(f.name)) s += 3;
    return { f, s, idx };
  });
  // Top-tier candidates (within 1 point of the max). Round-robin via tieKey
  // so successive layers with the same metric land on DIFFERENT faces — no
  // more "everything is Pretendard".
  const maxScore = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s >= maxScore - 1);
  const pick = top[Math.abs(tieKey) % top.length];
  return pick.f;
}

// Cheap stable integer hash for tie-breaking in findFont — based on the text
// content so the same word maps to the same font on every re-render.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// Font matcher using Tesseract word metadata when present, plus stroke-width
// fallback for bold detection. Returns { font, size, weight, isBold, isItalic }.
export function guessFont(word, imageCanvas) {
  if (!word || !word.bbox) return { font: SYSTEM_FONTS[0], size: 14, weight: 400, isBold: false, isItalic: false };
  const { x0, y0, x1, y1 } = word.bbox;
  const height = Math.max(8, y1 - y0);
  const width = Math.max(2, x1 - x0);
  const text = word.text || '';
  const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);

  // Read Tesseract-provided font hints when available.
  let isBold = !!word.is_bold;
  let isItalic = !!word.is_italic;
  let isSerif = !!word.is_serif;
  let isMono = !!word.is_monospace;
  let boldConfidence = 0;
  let strokeRatio = 0; // stroke-width / glyph-height, set inside the heuristic

  // Stroke-width heuristic. For each scan line in the bbox, find runs of dark
  // pixels (= stroke crossings) and take the median run length. The median
  // stroke width divided by glyph height is a robust bold signal across
  // scripts — Korean glyphs naturally have more strokes so a flat
  // pixel-density threshold (the old 30 % rule) over-triggers; stroke width
  // per row is invariant to glyph complexity.
  if (imageCanvas) {
    try {
      const ctx = imageCanvas.getContext('2d');
      // Sample at most the first ~200px wide window — enough to characterise
      // the face, cheap on large headlines.
      const w = Math.min(width, 240);
      const h = Math.min(height, 80);
      const data = ctx.getImageData(x0, y0, w, h).data;
      const rowStrokes = [];
      // Mean luminance of the row's pixels → adaptive threshold per row.
      for (let y = 0; y < h; y++) {
        const rowStart = y * w * 4;
        let lumSum = 0;
        for (let x = 0; x < w; x++) {
          const i = rowStart + x * 4;
          lumSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const rowMean = lumSum / w;
        // 70 % between row mean and pure-black is "dark" — keeps thresholds
        // adaptive to coloured / anti-aliased text.
        const thr = Math.min(160, rowMean - 30);
        const runs = [];
        let runLen = 0;
        for (let x = 0; x < w; x++) {
          const i = rowStart + x * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (lum < thr) runLen++;
          else if (runLen > 0) { runs.push(runLen); runLen = 0; }
        }
        if (runLen > 0) runs.push(runLen);
        if (runs.length) rowStrokes.push(median(runs));
      }
      if (rowStrokes.length > 4) {
        const stroke = median(rowStrokes);
        const ratio = stroke / h;
        // Empirical thresholds calibrated against real renderings:
        //   regular  : ratio ≈ 0.06–0.10
        //   medium   : ratio ≈ 0.11–0.13
        //   bold     : ratio ≈ 0.13–0.20
        //   black    : ratio ≈ 0.20+
        // Lowered from 0.155/0.130 → 0.130/0.110 so titles like "식권대장
        // 인바운드 인입 분석" — which sit right at the bold/medium border —
        // are reliably picked up as bold.
        const boldThreshold = isKorean ? 0.130 : 0.110;
        if (ratio > boldThreshold) {
          isBold = true;
          boldConfidence = Math.min(1, (ratio - boldThreshold) * 8);
        }
        strokeRatio = ratio;
      }
    } catch {}
  }

  const kind = isMono ? 'mono' : isSerif ? 'serif' : 'sans';
  const script = isKorean ? 'ko' : 'lat';
  // Three-tier weight: regular → bold → ultra-bold (Black). Very thick
  // strokes (Black Han Sans / Noto Sans KR Black territory) get weight 900
  // so the canvas renders them with the right CSS face.
  let weight;
  if (strokeRatio > 0.20)      weight = 900;
  else if (isBold)             weight = 700;
  else                         weight = 400;
  const fontSizePx = height;
  // tieKey makes successive layers with identical metrics map to DIFFERENT
  // fonts (round-robin among tied candidates) instead of all landing on
  // Pretendard. Stable per text so re-renders are consistent.
  const tieKey = hashStr(text);
  const match = findFont({
    kind, script, weight,
    preferBoldName: isBold,
    strokeRatio, fontSizePx, tieKey,
  });

  // Prefer Tesseract font_size when reasonable; otherwise derive from bbox height.
  const tsize = Number(word.font_size);
  const size =
    tsize && tsize >= 8 && tsize <= 200
      ? Math.round(tsize)
      : Math.round(height * (isKorean ? 0.88 : 0.78));

  return { font: match, size, weight, isBold, isItalic, boldConfidence };
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Direct-name nicknames so common PDF-embedded faces resolve to a specific
// SYSTEM_FONT instead of relying on heuristics. Keys are lowercased PDF font
// names (subset prefixes stripped); values are SYSTEM_FONT names.
const PDF_FONT_ALIASES = {
  'pretendard': 'Pretendard',
  'pretendard-bold': 'Pretendard Bold',
  'pretendard-medium': 'Pretendard Medium',
  'pretendard-semibold': 'Pretendard SemiBold',
  'suit': 'SUIT',
  'suit-bold': 'SUIT Bold',
  'notosanskr': 'Noto Sans KR',
  'notosanskr-regular': 'Noto Sans KR',
  'notosanskr-bold': 'Noto Sans KR Bold',
  'notosanskr-medium': 'Noto Sans KR Medium',
  'notosanskr-black': 'Noto Sans KR Black',
  'notosans-kr': 'Noto Sans KR',
  'notoserifkr': 'Noto Serif KR',
  'notoserifkr-bold': 'Noto Serif KR Bold',
  'nanumgothic': 'Nanum Gothic',
  'nanumgothic-bold': 'Nanum Gothic Bold',
  'nanumbarungothic': 'Nanum Gothic',
  'nanummyeongjo': 'Nanum Myeongjo',
  'nanummyeongjo-bold': 'Nanum Myeongjo Bold',
  'ibmplexsanskr': 'IBM Plex Sans KR',
  'ibmplexsans': 'IBM Plex Sans',
  'ibmplexserif': 'IBM Plex Serif',
  'ibmplexmono': 'IBM Plex Mono',
  'spoqahansansneo': 'Pretendard',           // visually very close — same designer family
  'spoqahansans': 'Pretendard',
  'malgungothic': 'Noto Sans KR',
  'applesdgothicneo': 'Pretendard',
  'helvetica': 'Helvetica',
  'helvetica-bold': 'Helvetica Bold',
  'arial': 'Arial',
  'inter': 'Inter',
  'inter-bold': 'Inter Bold',
  'roboto': 'Roboto',
  'roboto-bold': 'Roboto Bold',
  'georgia': 'Georgia',
  'times': 'Times',
  'timesnewroman': 'Times',
  'courier': 'Courier',
  'couriernew': 'Courier',
};

// Map a PDF font name to the best SYSTEM_FONT. Strategy:
//   1. Strip the 6-char subset prefix ("ABCDEF+...") and look up direct alias.
//   2. Otherwise score every candidate against parsed traits — kind (sans/
//      serif/mono), script (ko/lat), weight — preferring exact matches.
//   3. Optionally width-calibrate against `originalWidthPx`: pick the
//      candidate whose ctx.measureText() at the same font size best matches
//      the original glyph width, so Korean glyphs don't reflow on edit.
export function matchPdfFont(fontName, text, style, opts = {}) {
  const raw = String(fontName || '').replace(/^[A-Z]{6}\+/, '');
  // Two normalised forms: with and without hyphens, so font names like
  //   "Pretendard-Bold" / "PretendardBold" / "pretendard_bold"
  // all collapse to the same lookup keys.
  const lower = raw.toLowerCase().replace(/[\s_]/g, '');
  const lowerNoDash = lower.replace(/-/g, '');
  const styleFamily = (style?.fontFamily || '').toLowerCase();
  const combined = `${lower} ${styleFamily}`;
  // Bold signal pulled out early so the alias lookup can upgrade a Regular
  // hit to the Bold sibling when the PDF font name flagged bold.
  const nameHasBold = /bold|black|heavy|semibold|demi/.test(combined);

  // Helper: when an alias lookup landed on a Regular face but the font name
  // also signals bold, upgrade to the same family's Bold variant.
  const upgradeBold = (hit) => {
    if (!hit || !nameHasBold) return hit;
    if (/bold|black|heavy/i.test(hit.name)) return hit; // already bold
    const bolder = SYSTEM_FONTS.find((f) =>
      f.family === hit.family && /bold|black|heavy/i.test(f.name)
    );
    return bolder || hit;
  };

  // 1) Direct alias hit (with or without dashes).
  let hit = SYSTEM_FONTS.find((f) => f.name === (PDF_FONT_ALIASES[lower] || PDF_FONT_ALIASES[lowerNoDash]));
  if (hit) {
    hit = upgradeBold(hit);
    return { font: hit, weight: hit.weight };
  }
  // 2) Prefix-match (sort longest first so "pretendard-bold" beats "pretendard").
  const sortedKeys = Object.keys(PDF_FONT_ALIASES).sort((a, b) => b.length - a.length);
  const aliasKey = sortedKeys.find((k) => lower.startsWith(k) || lowerNoDash.startsWith(k.replace(/-/g, '')));
  if (aliasKey) {
    let h = SYSTEM_FONTS.find((f) => f.name === PDF_FONT_ALIASES[aliasKey]);
    h = upgradeBold(h);
    if (h) return { font: h, weight: h.weight };
  }

  // 2) Heuristic scoring on traits.
  const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text || '');
  const isBold =
    /bold|black|heavy|semibold|demi/.test(combined) ||
    (style?.fontFamily && /\b700\b|\b800\b|\b900\b/.test(style.fontFamily));
  const isLight = /light|thin/.test(combined);
  const isSerif = /serif|times|roman|batang|myungjo|gungsuh|sourcehanserif|notoserif|merriweather/.test(combined);
  const isMono = /mono|courier|consolas|menlo|gulimche|jetbrains/.test(combined);
  const weight = isBold ? 700 : isLight ? 300 : 400;
  const kind = isMono ? 'mono' : isSerif ? 'serif' : 'sans';
  const script = isKorean ? 'ko' : 'lat';

  const scored = SYSTEM_FONTS.map((f) => {
    let s = 0;
    if (f.kind === kind) s += 6;
    else if (kind === 'sans' && f.kind === 'serif') s -= 4;
    if (!f.script || f.script === script) s += 4;
    else if (script === 'ko' && f.script === 'lat') s -= 8; // Latin font on Korean text would tofu
    const wd = Math.abs((f.weight || 400) - weight);
    s += Math.max(0, 4 - Math.round(wd / 100));
    return { f, s };
  }).sort((a, b) => b.s - a.s);

  let pool = scored.slice(0, 6).map((x) => x.f);

  // 3) Width calibration — pick the top scorer whose rendered text width
  //    is closest to the source. This is what keeps Korean layout intact:
  //    even small per-glyph width differences add up across a long line.
  if (opts.originalWidthPx && opts.fontSizePx && text) {
    const ctx = getMeasureCtx();
    let best = pool[0], bestDelta = Infinity;
    for (const f of pool) {
      ctx.font = `${f.weight || 400} ${opts.fontSizePx}px ${f.family}`;
      const w = ctx.measureText(text).width;
      const delta = Math.abs(w - opts.originalWidthPx);
      if (delta < bestDelta) { bestDelta = delta; best = f; }
    }
    return { font: best, weight: best.weight };
  }

  // Diversification: among the top heuristic candidates, round-robin on
  // text hash so two different lines with identical Korean-sans-400 scores
  // don't BOTH resolve to Pretendard. Each line gets a stable but distinct
  // pick (Pretendard / SUIT / Noto / Nanum / IBM Plex / Gothic A1 …).
  const tieKey = Math.abs(hashStr(text));
  return { font: pool[tieKey % pool.length], weight: pool[0].weight };
}

let _measureCtx = null;
function getMeasureCtx() {
  if (_measureCtx) return _measureCtx;
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  _measureCtx = c.getContext('2d');
  return _measureCtx;
}

// System Korean fonts that ship with the OS — used as a guaranteed-glyph
// fallback so Korean text never falls through to a Latin-only system sans.
// Korean OS fallbacks. The CSS font-weight on the element selects the
// matching face (Apple SD Gothic Neo, Malgun Gothic, etc. all ship with
// multiple weights), so a layer with font-weight: 700 will render in the
// bold cut of whichever face is present locally — no need for separate
// "Malgun Gothic Bold" family names.
export const KOREAN_FALLBACK = '"Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "Nanum Gothic", "Noto Sans KR"';
export const LATIN_FALLBACK = '"Helvetica Neue", Helvetica, Arial';

// Build a CSS font-family chain. Priority:
//   1. The PDF's actual embedded font (pdfjs-registered family) — perfect fidelity
//   2. The web font we matched by name + width similarity
//   3. Script-appropriate system fallback (Korean OS fonts for ko, sans/serif for lat)
//   4. Generic CSS family
// `quote` wraps multi-word family names in double-quotes to keep CSS happy.
export function buildFontFamilyChain({ pdfFamily, matchedFontFamily, isKorean, kind = 'sans' }) {
  const parts = [];
  if (pdfFamily) parts.push(/[^A-Za-z0-9_-]/.test(pdfFamily) ? `"${pdfFamily}"` : pdfFamily);
  if (matchedFontFamily && !parts.includes(matchedFontFamily)) parts.push(matchedFontFamily);
  if (isKorean) parts.push(KOREAN_FALLBACK);
  else parts.push(LATIN_FALLBACK);
  parts.push(kind === 'serif' ? 'serif' : kind === 'mono' ? 'monospace' : 'sans-serif');
  return parts.join(', ');
}
