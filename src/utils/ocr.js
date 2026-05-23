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
    // Per-row longest dark-pixel run length. Only horizontal lines are
    // suppressed (see below).
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
    // Mask HORIZONTAL rules only. Vertical rules are intentionally preserved
    // because Tesseract leans on them to keep adjacent cells separate — wipe
    // them and "업체명 (주)와이유 대표자 유정태" fuses into a single OCR line.
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
    return out;
  } catch {
    return srcCanvas;
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
