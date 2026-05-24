import { memo, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { loadImage, fileToDataURL, canvasToBlob } from '../../utils/image';
import { recognizeImage, guessFont, matchPdfFont, buildFontFamilyChain, suppressTableLines, tightenBBoxToGlyphs, detectVerticalText, preprocessForOcr, assessPdfTextQuality, looksGarbledKorean, detectBoldByStroke } from '../../utils/ocr';
import { loadPdfJs, renderPageToCanvas, downloadBlob, extractPageTextItems } from '../../utils/pdf';
import { PDFDocument } from 'pdf-lib';
import { useFontsReady } from '../../utils/fonts';
import { SYSTEM_FONTS } from '../../utils/ocr';
import TextLayersOverlay from '../../components/TextLayersOverlay';
import PropertiesToolbar from '../../components/PropertiesToolbar';
import ConfirmDialog from '../../components/ConfirmDialog';

const FONT_OPTIONS = SYSTEM_FONTS;

// Issue #26 A — module-load marker. Prints once when this JS chunk
// is first evaluated. If you don't see this line in devtools console
// when the text-edit page is open, the browser is serving a CACHED
// bundle and any code changes here aren't actually running.
console.log(
  '%c[TextEdit] module loaded · build=' +
  (import.meta.env.VITE_COMMIT_SHA || 'dev').slice(0, 7) +
  ' · branch=' + (import.meta.env.VITE_BRANCH || 'local') +
  ' · garble-v2 (sub-token scan)',
  'color: white; background: #2563eb; padding: 2px 6px; border-radius: 3px;'
);

export default function TextEdit() {
  // pages: [{ id, name, canvas, layers, ocrDone }]
  const [pages, setPages] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [srcName, setSrcName] = useState('');
  const previewRef = useRef(null);

  const current = pages[currentIdx];
  const fontsTick = useFontsReady();
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const [dispScale, setDispScale] = useState(1);
  const [editMode, setEditMode] = useState('sentence');
  // Id of the layer whose inline <input> is currently open. Used by
  // `renderEdits` to (a) erase the original glyph footprint immediately
  // on edit open and (b) skip the canvas text draw for that layer, so the
  // user only sees their own typing — not the canvas-rendered copy bleeding
  // through on top of the input (the "텍스트가 덮어지는" issue).
  const [editingLayerId, setEditingLayerId] = useState(null);
  const editingLayerIdRef = useRef(null);
  editingLayerIdRef.current = editingLayerId;
  // Confirm dialog used by both delete modes — guards against accidental
  // wipes. Enter = Yes, Esc = No (wired inside the dialog component).
  const [confirmState, setConfirmState] = useState(null);
  const wrapRef = useRef(null);

  // Memoised selected-layer reference. The downstream PropertiesToolbar is
  // wrapped in React.memo and only re-renders when its watched fields change,
  // so drag patches (which mutate x/y on every mousemove) no longer trigger a
  // toolbar re-render. This is the main perf win after dropping the right
  // panel's 50+ controlled inputs.
  const selectedLayer = useMemo(
    () => (current && selectedLayerId) ? current.layers.find((l) => l.id === selectedLayerId) || null : null,
    [current?.layers, selectedLayerId]
  );

  // ── Undo/Redo history ─────────────────────────────────────────────────────
  // Each entry snapshots only mutable state (layers + eraseRegions per page).
  // Canvas + pdfText references are reused so memory stays light.
  const undoStack = useRef([]);
  const redoStack = useRef([]);
  // Undo/redo buttons read length from the refs; a tiny counter forces the
  // single render that toggles their disabled state. Not used elsewhere — do
  // NOT thread this through the heavy render tree.
  const [historyTick, setHistoryTick] = useState(0);
  const bumpHistoryUi = () => setHistoryTick((n) => n + 1);

  // Drag-active flag — set by the overlay when a layer drag is in progress.
  // The canvas-redraw effect bails while this is true; the overlay paints the
  // moved layer via CSS so the user still sees the new position in real time,
  // and we re-rasterise once on drag end.
  const dragActiveRef = useRef(false);
  const handleDragActiveChange = (active) => {
    const was = dragActiveRef.current;
    dragActiveRef.current = active;
    // Drag end → schedule one final redraw so the canvas catches up.
    if (was && !active) scheduleRedraw();
  };

  const snapshotPages = (ps) => ps.map((p) => ({
    id: p.id,
    layers: p.layers.map((l) => ({ ...l })),
    eraseRegions: (p.eraseRegions || []).map((r) => ({ ...r })),
  }));
  const restoreSnapshot = (snap) => {
    setPages((prev) => prev.map((p) => {
      const s = snap.find((x) => x.id === p.id);
      if (!s) return p;
      return { ...p, layers: s.layers.map((l) => ({ ...l })), eraseRegions: s.eraseRegions.map((r) => ({ ...r })) };
    }));
  };
  const pushHistory = () => {
    // Snapshot CURRENT pages state (the "before" state of the next mutation).
    undoStack.current.push(snapshotPages(pages));
    if (undoStack.current.length > 80) undoStack.current.shift();
    redoStack.current.length = 0;
    bumpHistoryUi();
  };
  const undo = () => {
    if (!undoStack.current.length) return;
    redoStack.current.push(snapshotPages(pages));
    const prev = undoStack.current.pop();
    restoreSnapshot(prev);
    bumpHistoryUi();
  };
  const redo = () => {
    if (!redoStack.current.length) return;
    undoStack.current.push(snapshotPages(pages));
    const next = redoStack.current.pop();
    restoreSnapshot(next);
    bumpHistoryUi();
  };

  // (The right-side per-layer card panel was replaced by the top properties
  // toolbar — no auto-scroll effect is needed any more.)

  // Global keyboard shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y, Ctrl/Cmd+B.
  useEffect(() => {
    const onKey = (e) => {
      if (confirmState) return;
      const target = e.target;
      // Don't hijack typing inside the inline text editor for plain typing,
      // but DO handle Ctrl+B even when an input is focused so users can
      // bold mid-edit (matches every word processor's behaviour).
      const inEditor = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        // Bold toggle requires a selected layer.
        if (!selectedLayerId) return;
        e.preventDefault();
        const layer = current?.layers.find((l) => l.id === selectedLayerId);
        if (!layer) return;
        pushHistory();
        update(selectedLayerId, {
          isBold: !layer.isBold,
          fontWeight: !layer.isBold ? 700 : 400,
        });
        return;
      }
      if (inEditor) return;
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pages, confirmState, selectedLayerId, current]);

  // Track canvas display size for overlay coord conversion.
  useEffect(() => {
    const c = previewRef.current;
    if (!c) return;
    const update = () => {
      if (c.width > 0) setDispScale(c.clientWidth / c.width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(c);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [current]);

  const onFiles = async (fs) => {
    const f = fs[0];
    if (!f) return;
    setSrcName(f.name);
    setBusy(true);
    try {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const pdf = await loadPdfJs(f);
        const out = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const c = await renderPageToCanvas(pdf, i, 2);
          // Try to extract the native PDF text layer at the same scale as the
          // rendered canvas. For text-based PDFs this gives exact positioning,
          // font size and baseline — far more accurate than re-running OCR.
          //
          // BUT: many Korean PDFs subset their fonts and map glyphs to PUA
          // codepoints without a usable ToUnicode CMap. pdfjs then returns
          // garbled strings — visually the page renders correctly (the
          // glyphs are there in the font), but `getTextContent()` decodes
          // them as random Latin sequences ("원두는" → "ATE"). We can't
          // edit text we can't read, so we run a quality check and discard
          // the PDF text layer entirely when it looks corrupted; the page
          // then falls through to the OCR pipeline below, which reads the
          // RENDERED glyphs and produces correct strings.
          let pdfText = null;
          try {
            pdfText = await extractPageTextItems(pdf, i, 2);
            if (pdfText && pdfText.items) {
              const q = assessPdfTextQuality(pdfText.items);
              if (!q.trusted) {
                console.warn(
                  `[TextEdit] Page ${i}: ${q.garbledCount}/${q.total} PDF text items look ` +
                  `corrupted (${Math.round(q.ratio * 100)}%) — falling back to OCR for this page.`
                );
                pdfText = null;
              }
            }
          } catch {}
          out.push({
            id: crypto.randomUUID(),
            name: `${f.name} · p${i}`,
            pageNum: i,
            canvas: c,
            layers: [],
            eraseRegions: [],
            ocrDone: false,
            pdfText,
          });
        }
        setPages(out);
        setCurrentIdx(0);
      } else {
        const url = await fileToDataURL(f);
        const im = await loadImage(url);
        const c = document.createElement('canvas');
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        c.getContext('2d').drawImage(im, 0, 0);
        setPages([{ id: crypto.randomUUID(), name: f.name, pageNum: 1, canvas: c, layers: [], eraseRegions: [], ocrDone: false }]);
        setCurrentIdx(0);
      }
    } finally {
      setBusy(false);
    }
  };

  const runOcrForPage = async (pageIdx, onProg) => {
    const page = pages[pageIdx];
    if (!page) return;

    // Diagnostic: which path was taken? PDF text path has garble filtering;
    // OCR fallback path does not. If 'no garble log' AND 'using OCR path'
    // → the garbled layer must come from elsewhere (e.g. Tesseract output).
    const _pdfItems = page.pdfText?.items?.length || 0;
    console.log(
      `[TextEdit] runOcrForPage page=${page.pageNum} path=${_pdfItems ? 'PDF-text' : 'OCR-fallback'} pdfItems=${_pdfItems} pdfTextPresent=${!!page.pdfText}`
    );

    // If we have a native PDF text layer, use it — exact positions, font size
    // and baselines straight from the PDF. No raster OCR, no heuristics.
    if (page.pdfText && page.pdfText.items && page.pdfText.items.length) {
      // The PDF text layer is already in memory; animate the bar in stages so
      // the user gets visible feedback instead of an instant 0→100 flicker.
      onProg?.({ progress: 0.15, stage: 'PDF 텍스트 레이어 읽는 중' });
      await sleep(60);
      // Make sure pdfjs's @font-face entries for embedded PDF fonts have
      // finished loading before we measure widths against them.
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
      onProg?.({ progress: 0.5, stage: '폰트/좌표 매핑 중' });
      await sleep(60);

      // ── Issue #26 A · page-context garble analysis ───────────────────────
      // `looksGarbledKorean` only flags items containing BOTH Korean and
      // suspicious Latin. PDFs frequently emit a corrupted Korean run as
      // MULTIPLE separate items (e.g. one item "ATE", another "2개월 단위",
      // another "EES", another "됩니다.") — the Latin-only fragments have
      // no Hangul context and slip through. Pre-scan the whole page:
      //   • garbledFonts : fontNames that produced ≥1 confirmed-garbled item
      //   • isKoreanPage : page-level Hangul ratio > 20 % (lets us treat
      //                    short-uppercase-Latin items as suspect — they're
      //                    almost certainly PUA glyph-name fallbacks for
      //                    CJK glyphs the subset CMap couldn't decode).
      const _allItems = page.pdfText.items;
      const _ALLOWED_STANDALONE = new Set([
        'AI', 'AR', 'VR', 'IT', 'OS', 'PC', 'TV', 'PD', 'CD', 'DVD', 'USB',
        'HD', 'FHD', 'UHD', '4K', '8K', 'OK', 'PDF', 'JPG', 'PNG', 'GIF',
        'CEO', 'CTO', 'CFO', 'API', 'SDK', 'SUV', 'GPS', 'LED', 'LCD',
        'OLED', 'IOS', 'IOT', 'SSD', 'HDD', 'CPU', 'GPU', 'RAM', 'ROM',
        'MP3', 'MP4', 'KBS', 'MBC', 'SBS', 'YTN', 'JTBC', 'NASA', 'NATO',
        'IMF', 'UN', 'WHO', 'CCTV', 'KTX', 'SRT', 'BTS', 'SK', 'LG', 'KT',
        'GS', 'CJ', 'SM', 'YG', 'JYP', 'BMW', 'KIA', 'EV', 'VAT', 'NO',
      ]);
      const _isStandaloneGarble = (t) => {
        const s = t.replace(/[\s.,()*·•\-_:]+/g, '');
        if (!s) return false;
        if (!/^[A-Z]{2,4}$/.test(s)) return false;
        if (_ALLOWED_STANDALONE.has(s)) return false;
        return true;
      };
      // Sub-token scan: split the item on whitespace + punctuation, then
      // check each fragment. Catches the case where pdfjs bundled a
      // garbled Latin run with a SHORT Korean fragment in the same item
      // (e.g. "단위 EES" — only 2 Hangul chars, below the looksGarbledKorean
      // 3-char threshold, so the bundled form slipped past per-item filter
      // AND post-merge final-pass. Sub-token scan finds EES directly.
      const _SUBTOKEN_SPLIT = /[\s,.()[\]{}<>"'/\\:;!?·•|\-_*]+/;
      const _hasEmbeddedLatinGarble = (t) => {
        for (const st of t.split(_SUBTOKEN_SPLIT)) {
          if (!st) continue;
          if (/^[A-Z]{2,4}$/.test(st) && !_ALLOWED_STANDALONE.has(st)) return true;
        }
        return false;
      };
      // Two-pass scan. First: per-item Hangul count + look-garbled detection.
      // Second: on Korean pages, also treat standalone-Latin garble AND
      // embedded-Latin garble as evidence a fontName is suspect — extends
      // garbledFonts so OTHER clean-looking items in the same font subset
      // also get scrutinised by the per-item filter below.
      let _hangulCharCount = 0, _totalCharCount = 0;
      const _suspectByFont = new Map(); // fontName → array of sample texts
      const _markSuspect = (it, reason) => {
        if (!it.fontName) return;
        if (!_suspectByFont.has(it.fontName)) _suspectByFont.set(it.fontName, []);
        const samples = _suspectByFont.get(it.fontName);
        if (samples.length < 3) samples.push(`${reason}:"${(it.text || '').trim()}"`);
      };
      for (const it of _allItems) {
        const t = (it.text || '').trim();
        if (!t) continue;
        _totalCharCount += t.length;
        _hangulCharCount += (t.match(/[가-힣]/g) || []).length;
        if (looksGarbledKorean(t)) _markSuspect(it, 'looksGarbled');
      }
      const _isKoreanPage = _totalCharCount > 0 && (_hangulCharCount / _totalCharCount) > 0.2;
      if (_isKoreanPage) {
        for (const it of _allItems) {
          const t = (it.text || '').trim();
          if (!t) continue;
          if (_isStandaloneGarble(t)) { _markSuspect(it, 'standalone'); continue; }
          if (_hasEmbeddedLatinGarble(t) && /[가-힣]/.test(t)) _markSuspect(it, 'embedded');
        }
      }
      const _garbledFonts = new Set(_suspectByFont.keys());
      // Diagnostic — visible in browser devtools so we can verify why a
      // specific page didn't flip a layer to dropped.
      console.log('[TextEdit] Issue #26 A garble analysis', {
        page: page.pageNum, totalItems: _allItems.length,
        totalChars: _totalCharCount, hangulChars: _hangulCharCount,
        hangulRatio: _totalCharCount ? +(_hangulCharCount / _totalCharCount).toFixed(3) : 0,
        isKoreanPage: _isKoreanPage,
        garbledFonts: Array.from(_suspectByFont.entries()).map(([f, s]) => ({ font: f, samples: s })),
      });

      const layers = page.pdfText.items
        .filter((it) => {
          const t = (it.text || '').trim();
          if (!t) return false;
          // Size floor — bumped from (w<2, h<4) to (w<6, h<6). Sub-6-px
          // boxes are almost always table-rule glyphs, dingbat dividers,
          // or a single PUA decoration char that pdfjs surfaced as a
          // "text" item. Real legible body text in our 2×-scaled canvas
          // grid is never < 10 px tall; the 6-px floor still leaves
          // headroom for small superscripts but eliminates the "tiny
          // stray box that moves with the row" complaint.
          if (it.w < 6 || it.h < 6) return false;
          // Aspect-based rule-line guard. A 25:1+ wide box made entirely
          // of underscores / dashes / dots / box-drawing chars is a
          // horizontal rule pretending to be text. Catches "________"
          // and "————" items that pass the alphanumeric check on a
          // lone underscore.
          if (it.w / Math.max(1, it.h) > 25 && /^[_·•．。⋯…\-—–=─━]+$/.test(t)) return false;
          if (!/[a-zA-Z0-9가-힣]|[^ -]/.test(t)) return false;
          // Per-item garble drop: even on pages whose overall garble ratio
          // sits below the page-level OCR-fallback threshold, individual
          // items can still be corrupt (mid-word capitalised Latin in a
          // Korean string, particle-free Hangul runs, lone-letter mix).
          // We drop those items entirely instead of letting them appear as
          // editable layers with nonsense text. The visible glyph stays on
          // the page bitmap; the user just can't edit it from this layer.
          if (looksGarbledKorean(t)) return false;
          // Page-context garble drop (Issue #26 A). On a predominantly-
          // Korean page:
          //   (a) any item using a fontName that produced a confirmed-
          //       garbled item is suspect — the corrupt CMap affects every
          //       glyph in that subset, so Latin-only fragments emitted
          //       through the same font are almost certainly PUA-CJK
          //       fallbacks. We drop them; clean Korean runs through the
          //       same font are kept (mixed-fontName pages can have one
          //       intact and one broken subset).
          //   (b) a standalone short uppercase Latin token ("ATE", "EES")
          //       that isn't a recognised acronym is dropped outright.
          if (_isKoreanPage) {
            if (it.fontName && _garbledFonts.has(it.fontName)) {
              const hasHangul = /[가-힣]/.test(t);
              const hasSuspectLatin = /[A-Z]{2,}/.test(t);
              if (!hasHangul || hasSuspectLatin) return false;
            }
            if (_isStandaloneGarble(t)) return false;
            // Embedded-Latin garble: catches "단위 EES" style where the
            // Latin run is bundled with too few Hangul chars (< 3) for
            // looksGarbledKorean to fire. On a Korean page any short
            // uppercase Latin token that isn't a recognised acronym is
            // almost certainly a PUA-CJK glyph-name fallback.
            if (_hasEmbeddedLatinGarble(t)) return false;
          }
          return true;
        })
        .map((it) => {
          const style = page.pdfText.styles?.[it.fontName];
          // Width-calibrated: among the top heuristic candidates, pick the
          // web font whose ctx.measureText() best matches the original glyph
          // width at this exact size. Keeps Korean lines from reflowing.
          const m = matchPdfFont(it.fontName, it.text, style, {
            originalWidthPx: it.w,
            fontSizePx: it.fontSize,
          });
          const rawBBox = {
            x0: Math.max(0, Math.floor(it.x)),
            y0: Math.max(0, Math.floor(it.y)),
            x1: Math.min(page.canvas.width, Math.ceil(it.x + it.w)),
            y1: Math.min(page.canvas.height, Math.ceil(it.y + it.h)),
          };
          // Glyph-tight bbox: scan ink pixels and crop to the true visible
          // glyph extent. PDFs commonly emit boxes spanning the full em
          // height (ascent + descent + leading), which is much taller than
          // the rendered glyphs for Korean text and for Latin text without
          // descenders — that excess is what made selection rectangles look
          // 30–60 % too tall in the editor. The pixel-tight version brings
          // it down to the real ink footprint.
          const tight = tightenBBoxToGlyphs(page.canvas, rawBBox);
          const bbox = tight ? { x0: tight.x0, y0: tight.y0, x1: tight.x1, y1: tight.y1 } : rawBBox;
          const tightBaseY = tight ? tight.baseY : (it.baseY ?? rawBBox.y1);
          const tightTop   = tight ? tight.glyphTop : rawBBox.y0;
          const bg = sampleBg(page.canvas, bbox);
          const fg = sampleFg(page.canvas, bbox, bg);
          // Vertical text flag — tall, narrow cells with multiple glyphs.
          const isVertical = detectVerticalText(page.canvas, bbox, it.text);
          const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(it.text);
          // Stroke-width bold detection against the rendered bitmap. The PDF
          // text path otherwise relies entirely on the embedded font name
          // (matchPdfFont) and matrix weight to decide bold — when the PDF
          // embedded a custom corporate font whose name doesn't contain
          // "Bold" / "Black" / "Heavy" (very common for unrecognised faces
          // that fall through to generic Pretendard mapping), visually bold
          // text rendered as Regular. Bitmap-stroke analysis is independent
          // of the font name and catches those cases. The result also feeds
          // into the matched weight upgrade below.
          const boldByStroke = detectBoldByStroke(page.canvas, bbox, isKorean);
          // Family chain: matched web font → Korean OS fallbacks → generic.
          //
          // We deliberately DO NOT prepend the pdfjs-registered family
          // (`it.pdfFamily`, e.g. "g_d0_f1"). pdfjs only embeds a subset
          // of glyphs from the original PDF font with a custom CMap; when
          // the user opens the inline editor — or even just enters edit
          // mode — the input element re-renders the same characters
          // through that subset and the result is unstable:
          //   * characters at weights the subset wasn't registered for
          //     (Bold of a Regular-only subset) fall through to a system
          //     font, breaking the visual weight;
          //   * some glyphs come back mapped to random Latin shapes
          //     (e.g. "원두는" → "ATE") when the input's font-shaping
          //     pass picks a different fallback than the canvas did.
          // The matched web font from matchPdfFont was already chosen with
          // width-calibration so Korean line widths don't reflow when we
          // switch to it. pdfFamily is still stored on the layer for
          // reference / diagnostics.
          const fontFamily = buildFontFamilyChain({
            pdfFamily: '',
            matchedFontFamily: m.font.family,
            isKorean,
            kind: m.font.kind || 'sans',
          });
          // Letter-spacing reconstruction: PDF advance width minus the natural
          // width the chosen font would render at the same size, divided by
          // the gap count. Clamped so OCR noise doesn't blow it up.
          const mctx = (typeof document !== 'undefined')
            ? document.createElement('canvas').getContext('2d')
            : null;
          let letterSpacing = 0;
          if (mctx && it.text.length > 1) {
            mctx.font = `${m.weight} ${it.fontSize}px ${fontFamily}`;
            const native = mctx.measureText(it.text).width;
            const delta = (it.w - native) / (it.text.length - 1);
            if (isFinite(delta) && Math.abs(delta) < it.fontSize * 0.4) {
              letterSpacing = delta;
            }
          }
          // Layer geometry uses the LINE-BOX height (≈ fontSize) so the
          // editor input — whose height is `fontSize × scale` — fits the
          // box exactly. Earlier we shrank `h` to the visible-ink height,
          // but that made the box smaller than the input, so the input
          // glyphs extended past the box border and the bottom of the
          // text was visually clipped on edit / move. Tight detection is
          // still useful for baseline accuracy: we keep the pixel-tight
          // `baseY` and align the line-box to it (top = baseY − ascent).
          const ascentRatio  = it.fdAscent  != null
            ? Math.min(0.98, Math.max(0.6, it.fdAscent  / (it.fdAscent + (it.fdDescent ?? 0.2))))
            : 0.84;
          const layerH = Math.max(8, it.fontSize);
          const layerAscent  = layerH * ascentRatio;
          const layerDescent = layerH - layerAscent;
          const layerX = bbox.x0;
          // Anchor the line-box to the detected ink baseline. Falls back
          // to the raw PDF baseY when pixel-tighten declined to refine
          // (e.g. very low-contrast cell).
          const baselineY = tightBaseY;
          const layerY = Math.max(0, Math.round(baselineY - layerAscent));
          const layerW = bbox.x1 - bbox.x0;
          return {
            id: crypto.randomUUID(),
            text: it.text,
            originalText: it.text,
            x: layerX,
            y: layerY,
            w: layerW,
            h: layerH,
            originalX: layerX,
            originalY: layerY,
            originalW: layerW,
            originalH: layerH,
            baseY: baselineY,
            // Pixel-tight glyph extent — stored separately from the line-box
            // so the erase pass can wipe EXACTLY the rendered ink without
            // bleeding into the line-spacing above / below (which can hold
            // adjacent table-row text).
            glyphTop: tightTop,
            glyphBottom: tightBaseY,
            ascent: layerAscent,
            descent: layerDescent,
            angleDeg: it.angleDeg || (isVertical ? -90 : 0),
            skewXDeg: it.skewXDeg || 0,
            isVertical,
            letterSpacing,
            lineHeight: it.fontSize, // single-line PDF item: line-height equals font-size
            pdfFamily: it.pdfFamily || '',
            fontFamily,
            fontName: m.font.name,
            fontSize: it.fontSize,
            // Final weight = max(matched weight, bitmap-detected weight). If
            // the rendered glyphs are visually bold (stroke ratio > thresh)
            // but the embedded font name didn't say so, bump to 700 (or 900
            // for ultra). This is what makes "볼드 처리된 텍스트 인식" work
            // for PDFs whose corporate font has a neutral name.
            fontWeight: Math.max(
              m.weight,
              boldByStroke.isUltra ? 900 : (boldByStroke.isBold ? 700 : 0)
            ),
            isBold:
              m.weight >= 600 ||
              /bold|black|heavy|semibold|demi/i.test(it.fontName) ||
              boldByStroke.isBold,
            isItalic: !!it.skewXDeg || /italic|oblique/i.test(it.fontName),
            color: fg,
            bgColor: bg,
            // Per-word bboxes powered by measureText against the matched
            // font — replaces the previous uniform char-width estimate so
            // proportional fonts (Inter, Pretendard …) yield word boundaries
            // that line up with the actual rendered glyphs. Click-to-word
            // selection therefore hits the visible word every time, even
            // mid-sentence.
            words: synthWordsMeasured(it.text, layerX, layerY, layerW, layerH, {
              fontFamily,
              fontSize: it.fontSize,
              fontWeight: m.weight,
              letterSpacing,
            }),
            visible: true,
            edited: false,
            source: 'pdf',
          };
        });
      // Dedup overlapping-bbox duplicates FIRST — Korean PDFs frequently
      // emit a visible glyph item AND an invisible ActualText item at the
      // same position; both came out as editable layers and the user
      // ended up editing one while the other still rendered on top.
      // Then run sentence-merge on the survivors so fragments split by
      // pdfjs's tokeniser (one per font, kerning gap, operator boundary)
      // collapse into one editable phrase.
      let mergedLayers = mergeAdjacentLayers(dedupOverlappingLayers(layers));
      // ── Issue #26 A · final safety net ───────────────────────────────────
      // Drop garble that survived per-item filtering AND merging. Reasons
      // this catches more than the upstream filter:
      //   • Merging can reintroduce garble by concatenating two clean
      //     fragments whose joined form trips looksGarbledKorean.
      //   • Some garbled items pass per-string check because the string
      //     ALONE looks OK in isolation, but on a Korean-dominant page the
      //     same content is clearly bogus (the standalone-Latin rule).
      // This pass uses the same predicates as the upstream filter but on
      // the FINAL layer text — so any path that produced a garbled layer
      // gets cleaned up here.
      if (_isKoreanPage) {
        const beforeCount = mergedLayers.length;
        mergedLayers = mergedLayers.filter((l) => {
          const t = (l.text || '').trim();
          if (!t) return false;
          if (looksGarbledKorean(t)) return false;
          if (_isStandaloneGarble(t)) return false;
          if (_hasEmbeddedLatinGarble(t)) return false;
          return true;
        });
        if (mergedLayers.length !== beforeCount) {
          console.log(
            `[TextEdit] Issue #26 A final-pass dropped ${beforeCount - mergedLayers.length} layer(s) on page ${page.pageNum}`
          );
        }
      }
      onProg?.({ progress: 0.95, stage: '레이어 적용 중' });
      await sleep(40);
      setPages((ps) => ps.map((p, i) => (i === pageIdx ? { ...p, layers: mergedLayers, ocrDone: true } : p)));
      onProg?.({ progress: 1, stage: '완료' });
      return;
    }

    // Fallback: rasterized OCR for scans / image-only PDFs / images.
    onProg?.({ stage: 'OCR 전처리 중' });
    // Preprocess: 2× upscale low-DPI pages, sharpen anti-aliased edges,
    // and snap row-local background noise to white so Tesseract's
    // adaptive classifier doesn't get confused by JPEG ringing around
    // small Korean glyphs. Then suppress in-cell ruling lines so cell
    // borders don't get merged into adjacent glyphs.
    const preProc  = preprocessForOcr(page.canvas);
    const ocrInput = suppressTableLines(preProc);
    onProg?.({ stage: 'Tesseract OCR 인식 중' });
    const data = await recognizeImage(ocrInput, onProg);

    // Tesseract bboxes returned in `ocrInput` pixel space — when the
    // preprocessor scaled the canvas 2× we need to map coords back down
    // to the ORIGINAL page.canvas grid (which is what layer x/y/w/h
    // reference for erase, bitmap-lift, and the overlay). One scale
    // factor handles both axes (we never anisotropic-scale).
    const ocrScale = preProc.width / page.canvas.width;
    if (ocrScale !== 1 && data.lines) {
      for (const ln of data.lines) {
        if (ln.bbox) {
          ln.bbox.x0 /= ocrScale; ln.bbox.x1 /= ocrScale;
          ln.bbox.y0 /= ocrScale; ln.bbox.y1 /= ocrScale;
        }
        for (const w of (ln.words || [])) {
          if (w.bbox) {
            w.bbox.x0 /= ocrScale; w.bbox.x1 /= ocrScale;
            w.bbox.y0 /= ocrScale; w.bbox.y1 /= ocrScale;
          }
        }
      }
    }

    const rawLines = data.lines || [];

    // Sanity cap derived from the WHOLE-PAGE distribution of word heights.
    // Tesseract occasionally reports a single word with a bbox 3-5× the real
    // glyph height — when that happens the layer ends up with fontSize 100+
    // for what should be 25 px body text, the inline editor balloons, and
    // the rendered glyphs appear at the wrong scale. Computing the median
    // height once gives us a robust per-page baseline; anything dramatically
    // larger than the body-text median is rejected or capped.
    const allWordHeights = rawLines
      .flatMap((ln) => (ln.words || []))
      .map((w) => (w?.bbox?.y1 ?? 0) - (w?.bbox?.y0 ?? 0))
      .filter((h) => h > 4)
      .sort((a, b) => a - b);
    const docMedianH = allWordHeights.length
      ? allWordHeights[Math.floor(allWordHeights.length / 2)]
      : 0;
    // Layers taller than this are almost always misdetected (e.g. an OCR
    // bbox that swallowed multiple rows because a vertical rule wasn't
    // suppressed). Skip them entirely.
    const heightSkipPx = docMedianH ? docMedianH * 2.5 : Infinity;
    // Cap any individual layer's fontSize at this many px regardless of what
    // word-height analysis returns. Generous (1.8×) so genuinely tall
    // headlines on the same page still render — but not 5× tall.
    const fontSizeCapPx = docMedianH ? docMedianH * 1.8 : Infinity;
    // Two-pass cell splitting:
    //   (1) splitOcrLineByRows  — Tesseract with PSM 6 merges vertically
    //       adjacent text in the same column into ONE line (a multi-line cell
    //       like "미디엄 다크 로스팅 커피로 다크초콜릿을 / 한입 베어먹은 듯한 /
    //       프리미엄 원두" becomes one line with bbox-height of 3 rows). Split
    //       on Y-gap between successive words.
    //   (2) splitOcrLineByCells — re-splits the result on X-gap so a single
    //       table row (multiple cells with the column rule suppressed) breaks
    //       into per-cell pseudo-lines.
    // After both passes each output represents one visual table cell.
    const lines = [];
    for (const rawLine of rawLines) {
      for (const rowLine of splitOcrLineByRows(rawLine)) {
        for (const cell of splitOcrLineByCells(rowLine)) {
          lines.push(cell);
        }
      }
    }
    const layers = [];
    for (const line of lines) {
      const rawText = (line.text || '').trim();
      if (!rawText) continue;
      // Strip OCR-induced border / box-drawing artefacts BEFORE the meaningful-
      // content test, otherwise a line like "│ A │" passes the letter check on
      // its lone "A" but still carries the bars into the final layer.
      const text = rawText.replace(/[─-╿\|｜]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Confidence floor bumped to 55 — the previous 30 let through the
      // garbage you saw at the top of the page (stylised logo glyphs OCR'd
      // into "A 저 서" / "CFFEE 놀부"). 55 still keeps decent body text and
      // drops the unrecoverable junk.
      if ((line.confidence ?? 100) < 60) continue;
      // Must contain real text content — same hasTextContent rule used on the
      // PDF path.
      if (!/[a-zA-Z0-9가-힣]/.test(text)) continue;
      // Drop "single weird char" results that come from OCR misreading lone
      // glyphs / cell rulers (e.g. "A", "I", ":", "·"). Real text in this
      // document is always ≥ 2 meaningful characters.
      const meaningful = (text.match(/[a-zA-Z0-9가-힣]/g) || []).length;
      if (meaningful < 2 && text.length < 3) continue;
      const lbw = line.bbox.x1 - line.bbox.x0;
      const lbh = line.bbox.y1 - line.bbox.y0;
      if (lbw < 6 || lbh < 6) continue;
      // Page-relative sanity check: drop lines whose bbox is dramatically
      // taller than the median word height across the entire page. These
      // are misdetected OCR bboxes (one word reported with a 100+ px height
      // even though the actual glyph is 25 px) that would otherwise produce
      // a layer with absurd fontSize and a column-spanning visible box.
      if (lbh > heightSkipPx) continue;
      // stretched character. Drop them.
      if (lbw / lbh > 25 && meaningful < 4) continue;
      // Image-as-text filter: a single-word cell with very few
      // alphanumeric chars is almost always Tesseract grasping at logo
      // edges / icon noise. Real cells with one short word are like
      // "봉", "2" — those have meaningful >= 1 but ALSO live inside a
      // wider table cell, so we additionally require the cell to be
      // narrower than ~5× the line height (icons are usually square,
      // i.e. aspect ≈ 1).
      const wordCount = (line.words || []).length;
      if (wordCount <= 1 && meaningful < 2 && lbw / lbh < 5) continue;

      const g = guessFont(line, page.canvas);
      // Override the heuristic fontSize with the MEDIAN word-height-based
      // size when words are available. The line bbox can be much taller
      // than the actual glyphs (multi-line cells, paragraph leading), so
      // height × 0.88 over-estimates. Median word height tracks the real
      // visible glyph extent.
      const wHeights = (line.words || [])
        .map((w) => (w.bbox?.y1 ?? 0) - (w.bbox?.y0 ?? 0))
        .filter((h) => h > 4)
        .sort((a, b) => a - b);
      if (wHeights.length) {
        const medianH = wHeights[Math.floor(wHeights.length / 2)];
        const isK = /[가-힣]/.test(text);
        g.size = Math.round(medianH * (isK ? 0.88 : 0.78));
      }
      // Hard cap against the page-wide median. Anything wildly larger than
      // the body text is almost certainly a Tesseract bbox mistake — clamp
      // it so layer.fontSize stays in a sane range and the editor stops
      // ballooning. Real titles are usually <1.8× body height; that's
      // exactly fontSizeCapPx.
      if (fontSizeCapPx !== Infinity && g.size > fontSizeCapPx) {
        g.size = Math.round(fontSizeCapPx);
      }
      const bg = sampleBg(page.canvas, line.bbox);
      const fg = sampleFg(page.canvas, line.bbox, bg);
      const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
      const fontFamily = buildFontFamilyChain({
        pdfFamily: '',
        matchedFontFamily: g.font.family,
        isKorean,
        kind: g.font.kind || 'sans',
      });
      let letterSpacing = 0;
      if (text.length > 1 && typeof document !== 'undefined') {
        const mctx = document.createElement('canvas').getContext('2d');
        mctx.font = `${g.weight} ${g.size}px ${fontFamily}`;
        const native = mctx.measureText(text).width;
        const delta = (lbw - native) / (text.length - 1);
        if (isFinite(delta) && Math.abs(delta) < g.size * 0.4) letterSpacing = delta;
      }
      // Anchor the layer to the WORD bboxes, not the line bbox. Tesseract's
      // line bbox can include empty space above the actual glyphs (rule
      // padding, between-cell whitespace, multi-row noise).
      const wTops = (line.words || []).map((w) => w?.bbox?.y0).filter((y) => y > 0);
      const wBots = (line.words || []).map((w) => w?.bbox?.y1).filter((y) => y > 0);
      const wLefts = (line.words || []).map((w) => w?.bbox?.x0).filter((x) => x > 0);
      const wRights = (line.words || []).map((w) => w?.bbox?.x1).filter((x) => x > 0);
      const wordTop    = wTops.length   ? Math.min(...wTops)   : line.bbox.y0;
      const wordBot    = wBots.length   ? Math.max(...wBots)   : line.bbox.y1;
      const wordLeft   = wLefts.length  ? Math.min(...wLefts)  : line.bbox.x0;
      const wordRight  = wRights.length ? Math.max(...wRights) : line.bbox.x1;
      // Pixel-tight refinement: scan ink inside the word-derived rect and
      // crop further to the actual visible glyph extent. Tesseract's word
      // bboxes already hug the ink fairly well, but they routinely include
      // 1–3 px padding for the adaptive classifier; the pixel pass removes
      // it so the selection rectangle the user sees lines up exactly with
      // the glyph. The original ORIGINAL_* values are kept on the layer so
      // the erase pass still covers the full pre-edit footprint.
      const tight = tightenBBoxToGlyphs(page.canvas, {
        x0: wordLeft, y0: wordTop, x1: wordRight, y1: wordBot,
      });
      const layerX = tight ? tight.x0 : wordLeft;
      const layerW = (tight ? tight.x1 : wordRight) - layerX;
      const baseY  = tight ? tight.baseY : wordBot;
      // Line-box geometry anchored to the detected baseline. Using a tight
      // h = baseY − glyphTop made the editor input (height = fontSize ×
      // scale) overflow the box on edit, which clipped the bottom of the
      // text on move. fontSize-based h keeps box ↔ input ↔ canvas
      // baselines in sync; baseY remains accurate from the pixel scan.
      const layerH = Math.max(8, g.size);
      const layerAscent  = layerH * 0.84;
      const layerDescent = layerH - layerAscent;
      const layerY = Math.max(0, Math.round(baseY - layerAscent));
      const isVertical = detectVerticalText(page.canvas, {
        x0: layerX, y0: layerY, x1: layerX + layerW, y1: baseY,
      }, text);
      layers.push({
        id: crypto.randomUUID(),
        text,
        originalText: text,
        x: layerX,
        y: layerY,
        w: layerW,
        h: layerH,
        originalX: layerX,
        originalY: layerY,
        originalW: layerW,
        originalH: layerH,
        baseY,
        // Pixel-tight glyph extent for the erase pass — see PDF path comment.
        glyphTop: tight ? tight.glyphTop : wordTop,
        glyphBottom: baseY,
        ascent: layerAscent,
        descent: layerDescent,
        angleDeg: isVertical ? -90 : 0,
        isVertical,
        skewXDeg: g.isItalic ? 10 : 0,
        letterSpacing,
        lineHeight: g.size,
        pdfFamily: '',
        fontFamily,
        fontName: g.font.name,
        fontSize: g.size,
        fontWeight: g.weight,
        isBold: !!g.isBold,
        isItalic: !!g.isItalic,
        color: fg,
        bgColor: bg,
        // Internal word-list so 단어 수정 mode can offer per-word selection
        // without paying the cost of a separate layer per word.
        words: (line.words || []).map((w) => ({
          text: (w.text || '').trim(),
          bbox: w.bbox,
        })),
        visible: true,
        edited: false,
        source: 'ocr',
      });
    }
    // Dedup duplicate / overlapping layers FIRST (PDFs that emit visible
    // glyphs + invisible ActualText overlay create two layers per visual
    // text), then run the sentence-merge pass on the survivors.
    let mergedLayers = mergeAdjacentLayers(dedupOverlappingLayers(layers));
    // ── Issue #26 A · OCR-path garble filter ─────────────────────────────
    // When the PDF has no extractable text layer (image-only PDFs, scans,
    // or pages where pdfjs returned zero items), the rendered bitmap goes
    // through Tesseract. Tesseract occasionally misclassifies short
    // Korean glyph clusters as Latin acronyms ("원두는" → "ATE",
    // "택배출고" → "EES") — same visual garble pattern as the PDF-text
    // PUA fallback, just produced by a different stage. We apply the
    // same final-pass filter here so the user doesn't get a nonsense
    // editable layer on top of clean rendered text.
    //
    // Page-level context is computed across the OCR layers themselves
    // (not from a PDF text layer that doesn't exist on this path).
    {
      const _OCR_ALLOWED = new Set([
        'AI', 'AR', 'VR', 'IT', 'OS', 'PC', 'TV', 'PD', 'CD', 'DVD', 'USB',
        'HD', 'FHD', 'UHD', '4K', '8K', 'OK', 'PDF', 'JPG', 'PNG', 'GIF',
        'CEO', 'CTO', 'CFO', 'API', 'SDK', 'SUV', 'GPS', 'LED', 'LCD',
        'OLED', 'IOS', 'IOT', 'SSD', 'HDD', 'CPU', 'GPU', 'RAM', 'ROM',
        'MP3', 'MP4', 'KBS', 'MBC', 'SBS', 'YTN', 'JTBC', 'NASA', 'NATO',
        'IMF', 'UN', 'WHO', 'CCTV', 'KTX', 'SRT', 'BTS', 'SK', 'LG', 'KT',
        'GS', 'CJ', 'SM', 'YG', 'JYP', 'BMW', 'KIA', 'EV', 'VAT', 'NO',
      ]);
      const _OCR_SPLIT = /[\s,.()[\]{}<>"'/\\:;!?·•|\-_*]+/;
      const _isStandaloneOcrGarble = (t) => {
        const s = t.replace(/[\s.,()*·•\-_:]+/g, '');
        return /^[A-Z]{2,4}$/.test(s) && !_OCR_ALLOWED.has(s);
      };
      const _hasEmbeddedOcrGarble = (t) => {
        for (const st of t.split(_OCR_SPLIT)) {
          if (!st) continue;
          if (/^[A-Z]{2,4}$/.test(st) && !_OCR_ALLOWED.has(st)) return true;
        }
        return false;
      };
      let hangulChars = 0, totalChars = 0;
      for (const l of mergedLayers) {
        const t = (l.text || '').trim();
        totalChars += t.length;
        hangulChars += (t.match(/[가-힣]/g) || []).length;
      }
      const isKoreanPage = totalChars > 0 && hangulChars / totalChars > 0.2;
      const beforeCount = mergedLayers.length;
      const dropped = [];   // fully removed (pure noise — no bbox kept)
      const blanked = [];   // text cleared but bbox preserved for manual entry
      if (isKoreanPage) {
        mergedLayers = mergedLayers.reduce((acc, l) => {
          const t = (l.text || '').trim();
          if (!t) { acc.push(l); return acc; }
          // Pure standalone garble (a layer whose ENTIRE content is one
          // short uppercase Latin token like "EES") — no useful bbox
          // either, drop entirely.
          if (_isStandaloneOcrGarble(t)) { dropped.push(t); return acc; }
          // Mixed garble (Korean line with embedded Latin nonsense from
          // Tesseract — "* ATE 2개월 단위 EES 됩니다."). The bbox covers
          // a real visible row, so we keep the geometry but blank the
          // text. The user clicks the (now empty) layer and types in
          // the correct content directly.
          const isGarble = looksGarbledKorean(t) || _hasEmbeddedOcrGarble(t);
          if (isGarble) {
            blanked.push(t);
            acc.push({ ...l, text: '', originalText: '', words: [] });
            return acc;
          }
          acc.push(l);
          return acc;
        }, []);
      }
      console.log(
        `[TextEdit] Issue #26 A OCR-path garble analysis page=${page.pageNum} ` +
        `totalChars=${totalChars} hangulChars=${hangulChars} ` +
        `hangulRatio=${totalChars ? (hangulChars / totalChars).toFixed(3) : 0} ` +
        `isKoreanPage=${isKoreanPage} ` +
        `dropped=${dropped.length} blanked=${blanked.length} kept=${mergedLayers.length}/${beforeCount}`,
        { droppedTexts: dropped, blankedTexts: blanked }
      );
      // Self-audit: after the filter, look for survivors that LOOK like
      // garble we should have caught. Helps pin down exactly which layer
      // text shape is bypassing the current rules.
      const survivedGarble = mergedLayers.filter((l) => {
        const t = (l.text || '').trim();
        if (!t) return false;
        // Heuristic: any layer text containing an uppercase Latin run of
        // 2+ chars AND ≥ 1 Hangul char OR a standalone short uppercase
        // word — same surface pattern we want to drop.
        if (/[A-Z]{2,}/.test(t) && /[가-힣]/.test(t)) return true;
        if (/^[A-Z]{2,4}$/.test(t.replace(/[\s.,()*·•\-_:]+/g, ''))) return true;
        return false;
      });
      if (survivedGarble.length) {
        console.warn(
          `[TextEdit] Issue #26 A · ${survivedGarble.length} garble-shaped layer(s) STILL PRESENT after filter on page ${page.pageNum}:`,
          survivedGarble.map((l) => ({
            text: l.text,
            looksGarbledKorean: looksGarbledKorean(l.text),
            isStandalone: _isStandaloneOcrGarble(l.text),
            hasEmbedded: _hasEmbeddedOcrGarble(l.text),
            tokens: (l.text || '').split(_OCR_SPLIT).filter(Boolean),
            hangulCount: ((l.text || '').match(/[가-힣]/g) || []).length,
          }))
        );
      }
    }
    console.log(
      `[TextEdit] OCR-fallback produced ${mergedLayers.length} layers on page ${page.pageNum}`,
      mergedLayers.slice(0, 30).map((l) => l.text)
    );
    setPages((ps) => ps.map((p, i) => (i === pageIdx ? { ...p, layers: mergedLayers, ocrDone: true } : p)));
  };

  const runOcrCurrent = async () => {
    if (!current) return;
    setBusy(true);
    setProgress(0);
    setProgressLabel(current.pdfText?.items?.length ? 'PDF 텍스트 레이어 분석 중' : 'OCR 인식 중');
    try {
      await runOcrForPage(currentIdx, (p) => {
        if (p && p.progress != null) setProgress(Math.round(p.progress * 100));
        if (p && p.stage) setProgressLabel(p.stage);
      });
      setProgress(100);
      setProgressLabel('완료');
      await sleep(280);
    } finally {
      setBusy(false);
      setProgressLabel('');
    }
  };

  const runOcrAll = async () => {
    setBusy(true);
    setProgress(0);
    setProgressLabel('전체 페이지 텍스트 추출 중');
    try {
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].ocrDone) continue;
        setProgressLabel(`페이지 ${i + 1} / ${pages.length} 처리 중`);
        await runOcrForPage(i, (p) => {
          if (p && p.progress != null) {
            const base = (i / pages.length) * 100;
            setProgress(Math.round(base + (p.progress * 100) / pages.length));
          }
        });
      }
      setProgress(100);
      setProgressLabel('완료');
      await sleep(280);
    } finally {
      setBusy(false);
      setProgressLabel('');
    }
  };

  // ── rAF-throttled canvas redraw ──────────────────────────────────────────
  // The redraw effect used to run synchronously on every `pages` mutation —
  // including every drag mousemove, which fired drawImage+renderEdits 60+ Hz
  // on a 2× rasterised page. Now we coalesce bursts into one redraw per
  // animation frame, and skip entirely while a layer drag is active (the
  // overlay box already shows the new position via CSS). On drag release the
  // handler flushes a final redraw so the canvas catches up to truth.
  const redrawRafRef = useRef(0);
  const latestCurrentRef = useRef(current);
  latestCurrentRef.current = current;

  const scheduleRedraw = () => {
    if (redrawRafRef.current) return;
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = 0;
      if (dragActiveRef.current) return;       // re-check at frame time
      const c = previewRef.current;
      const cur = latestCurrentRef.current;
      if (!c || !cur) return;
      c.width = cur.canvas.width;
      c.height = cur.canvas.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(cur.canvas, 0, 0);
      // Pass the currently-editing layer id so renderEdits can erase the
      // pre-edit glyphs immediately and skip drawing that layer on canvas —
      // the inline <input> is the sole renderer while editing.
      renderEdits(ctx, cur, editingLayerIdRef.current);
    });
  };

  useEffect(() => {
    // Schedule a redraw on any state change that affects the canvas. We do
    // NOT cancel any pending rAF in cleanup — `latestCurrentRef.current` is
    // re-bound on every render so a rAF queued during a previous render
    // will still read the LATEST state when it fires. Cancelling on every
    // effect re-run was a bug: when several state updates landed in a quick
    // succession during upload (setPages → fontsTick → dispScale → …) the
    // cleanup kept cancelling the rAF before it could ever fire, and the
    // canvas stayed empty even though the page object was sitting in state.
    scheduleRedraw();
  }, [current, currentIdx, pages, fontsTick, editingLayerId]);

  const update = (id, patch) => {
    setPages((ps) =>
      ps.map((p, i) =>
        i !== currentIdx
          ? p
          : {
              ...p,
              layers: p.layers.map((l) => {
                if (l.id !== id) return l;
                const next = { ...l, ...patch };
                const EDIT_KEYS = ['text', 'fontFamily', 'fontName', 'fontWeight', 'fontSize', 'color', 'bgColor', 'w', 'h', 'isBold', 'isItalic', 'letterSpacing', 'skewXDeg', 'lineHeight', 'textAlign'];
                const MOVE_KEYS = ['x', 'y'];
                if (EDIT_KEYS.some((k) => patch[k] !== undefined)) next.edited = true;
                if (MOVE_KEYS.some((k) => patch[k] !== undefined)) next.moved = true;
                if ('color' in patch) next.colorEdited = true;
                if ('bgColor' in patch) next.bgColorEdited = true;
                // When the user CHANGES the text content, drop the
                // heuristic letterSpacing that was reconstructed from the
                // ORIGINAL PDF advance widths. That value is meaningful
                // only for the original glyph run — applying it to typed
                // characters spreads them out visibly (the "글자 사이가
                // 벌어짐 / 폰트 패밀리 깨짐" symptom: "단,파손 등 고객과실"
                // → "단 파 손 등 고 객 과 실"). Letting the matched font's
                // native advance widths drive layout keeps the committed
                // result tight and readable. User can still hand-tune the
                // 자간 control afterwards if needed.
                if (patch.text !== undefined && patch.letterSpacing === undefined) {
                  next.letterSpacing = 0;
                }
                // Auto-resize the bbox WIDTH whenever any property that
                // affects rendered glyph width changes (text/font/size/
                // weight/letter-spacing). Without this the inline editor's
                // input was locked at the original cell width and longer
                // edits got visually clipped. We measure with the SAME font
                // string the canvas will use so the editor box and the
                // canvas redraw stay in sync. originalW stays unchanged so
                // the erase math still wipes the original glyph footprint.
                if (patch.text !== undefined || patch.fontSize !== undefined
                    || patch.fontFamily !== undefined || patch.fontWeight !== undefined
                    || patch.letterSpacing !== undefined) {
                  next.w = measureLayerWidth(next);
                }
                // Auto-adjust container height + reanchor on fontSize change.
                // The DETECTED baseline (next.baseY, captured at OCR time)
                // stays fixed — only the height around it is recomputed.
                // ascent uses the same 0.92/0.08 split we built the layer
                // with so drawTextOverlay's baseY = l.y + l.ascent still
                // lands exactly on the original glyph baseline.
                if (patch.fontSize !== undefined) {
                  const newSize = +patch.fontSize || 14;
                  const newH = Math.max(8, Math.round(newSize * 1.0));
                  const newAscent = newH * 0.92;
                  const fixedBase = next.baseY ?? (l.y + (l.ascent ?? l.h));
                  next.h = newH;
                  next.ascent = newAscent;
                  next.descent = newH * 0.08;
                  next.y = fixedBase - newAscent;
                  next.lineHeight = newSize;
                }
                return next;
              }),
            }
      )
    );
  };
  const toggleEdited = (id) => {
    setPages((ps) =>
      ps.map((p, i) =>
        i !== currentIdx ? p : { ...p, layers: p.layers.map((l) => (l.id === id ? { ...l, edited: !l.edited } : l)) }
      )
    );
  };
  const del = (id) => {
    setPages((ps) =>
      ps.map((p, i) => (i !== currentIdx ? p : { ...p, layers: p.layers.filter((l) => l.id !== id) }))
    );
  };

  // The raw mutations — kept private to TextEdit, always invoked through the
  // confirmation wrappers below so a stray click can't silently wipe data.
  const _doSoftDelete = (id) => {
    pushHistory();
    setPages((ps) => ps.map((p, i) => i !== currentIdx ? p : {
      ...p,
      layers: p.layers.map((l) => l.id === id ? { ...l, deleted: true, edited: false } : l),
    }));
  };
  const _doAddErase = (rect) => {
    pushHistory();
    setPages((ps) => ps.map((p, i) => i !== currentIdx ? p : {
      ...p,
      eraseRegions: [...(p.eraseRegions || []), { ...rect, color: '#ffffff' }],
    }));
  };

  // ezPDF: 텍스트 삭제 — opens a confirm dialog before covering the glyphs.
  const softDeleteLayer = (id) => {
    const layer = current?.layers.find((l) => l.id === id);
    const preview = (layer?.text || '').slice(0, 80);
    setConfirmState({
      message: '선택한 텍스트를 삭제하시겠습니까?',
      detail: preview ? `"${preview}${(layer?.text || '').length > 80 ? '…' : ''}"` : null,
      onYes: () => { setConfirmState(null); _doSoftDelete(id); },
      onNo: () => setConfirmState(null),
    });
  };
  // ezPDF: 영역 삭제 — opens a confirm dialog before painting the erase rect.
  const addEraseRegion = (rect) => {
    setConfirmState({
      message: '선택한 영역을 삭제하시겠습니까?',
      detail: `${Math.round(rect.w)} × ${Math.round(rect.h)} 픽셀 영역의 내용이 흰색으로 덮입니다.`,
      onYes: () => { setConfirmState(null); _doAddErase(rect); },
      onNo: () => setConfirmState(null),
    });
  };
  const removeEraseRegion = (idx) => {
    pushHistory();
    setPages((ps) => ps.map((p, i) => i !== currentIdx ? p : {
      ...p,
      eraseRegions: (p.eraseRegions || []).filter((_, j) => j !== idx),
    }));
  };

  // Compose a single page's final canvas (image + deletions + edits + erases).
  const composePageCanvas = (p) => {
    const c = document.createElement('canvas');
    c.width = p.canvas.width;
    c.height = p.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(p.canvas, 0, 0);
    renderEdits(ctx, p);
    return c;
  };

  const exportCurrentPng = async () => {
    if (!previewRef.current) return;
    const blob = await canvasToBlob(previewRef.current, 'image/png');
    downloadBlob(blob, `${stripExt(srcName) || 'edited'}-p${current.pageNum}.png`, 'image/png');
  };

  // Export all pages as a single PDF (each page = full-resolution PNG embedded
  // at the original canvas dimensions, so layout/scale are preserved).
  const exportPdf = async () => {
    if (!pages.length) return;
    setBusy(true);
    setProgress(0);
    setProgressLabel('PDF 생성 중');
    try {
      const doc = await PDFDocument.create();
      for (let i = 0; i < pages.length; i++) {
        setProgressLabel(`PDF 페이지 ${i + 1} / ${pages.length}`);
        const c = composePageCanvas(pages[i]);
        const blob = await canvasToBlob(c, 'image/png');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const img = await doc.embedPng(bytes);
        const page = doc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        setProgress(Math.round(((i + 1) / pages.length) * 100));
      }
      const pdfBytes = await doc.save();
      downloadBlob(pdfBytes, `${stripExt(srcName) || 'edited'}.pdf`, 'application/pdf');
      setProgressLabel('완료');
      await sleep(280);
    } finally {
      setBusy(false);
      setProgress(0);
      setProgressLabel('');
    }
  };

  const exportAllZip = async () => {
    setBusy(true);
    try {
      const zip = new JSZip();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const c = composePageCanvas(p);
        const blob = await canvasToBlob(c, 'image/png');
        zip.file(`${stripExt(srcName) || 'edited'}-p${String(p.pageNum).padStart(2, '0')}.png`, blob);
      }
      const out = await zip.generateAsync({ type: 'blob' });
      downloadBlob(out, `${stripExt(srcName) || 'edited'}-all.zip`, 'application/zip');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPages([]);
    setCurrentIdx(0);
    setSrcName('');
    setProgress(0);
  };

  return (
    <div className="content content-grid-2col" style={{ height: 'calc(100vh - 60px)' }}>
      <div className="panel">
        <h3>이미지 또는 PDF 업로드</h3>
        {pages.length === 0 ? (
          <DropZone accept="image/*,application/pdf" onFiles={onFiles} hint="이미지 단일 · 또는 PDF (전체 페이지)" />
        ) : (
          <>
            <div style={{ fontSize: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, marginBottom: 10 }}>{srcName}</div>
            <button className="btn" onClick={reset} style={{ width: '100%', marginBottom: 6 }}>다른 파일</button>
            <button className="btn primary" disabled={busy} onClick={runOcrCurrent} style={{ width: '100%', marginBottom: 6 }}>
              {busy ? `추출 ${progress}%` : current?.pdfText?.items?.length ? '현재 페이지 텍스트 추출' : '현재 페이지 OCR'}
            </button>
            {pages.length > 1 && (
              <button className="btn" disabled={busy} onClick={runOcrAll} style={{ width: '100%', marginBottom: 6 }}>
                {busy ? `전체 ${progress}%` : `전체 ${pages.length}페이지 추출`}
              </button>
            )}
            {current?.pdfText?.items?.length > 0 && !current.ocrDone && (
              <div style={{ fontSize: 11, color: 'var(--success)', padding: '4px 8px', background: '#f0fdf4', borderRadius: 4, marginBottom: 6 }}>
                ✓ PDF 텍스트 레이어 감지됨 ({current.pdfText.items.length}개) — 원본 폰트·사이즈·위치 보존
              </div>
            )}

            <h3 style={{ marginTop: 18 }}>페이지 ({pages.length})</h3>
            <div
              className="thumb-list"
              onClick={(e) => {
                // Click-delegation: pull the page id off the clicked card so the
                // per-thumb onClick prop stays referentially stable and the
                // memoised PageThumb skips renders during drag/edit.
                const card = e.target.closest('[data-page-idx]');
                if (!card) return;
                const idx = +card.dataset.pageIdx;
                if (!isNaN(idx)) setCurrentIdx(idx);
              }}
            >
              {pages.map((p, i) => (
                <PageThumb
                  key={p.id}
                  page={p}
                  pageIdx={i}
                  active={i === currentIdx}
                />
              ))}
            </div>
            <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>
              💡 텍스트를 <b>수정한 항목만</b> 결과에 반영됩니다. 원본 이미지·도형은 깨지지 않습니다.
            </p>
          </>
        )}
      </div>

      <div className="canvas-panel" style={{ position: 'relative' }}>
        <div className="canvas-toolbar">
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {current ? `Page ${current.pageNum} / ${pages.length}` : '미리보기'}
            {current?.ocrDone && (
              <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
                · {modeHint(editMode)}
              </span>
            )}
            {/* Build badge — shows the commit SHA the deployed bundle was
                built from. Lets the user verify they're running the latest
                code (vs. a cached old bundle). Falls back to "dev" when
                running via vite dev / when the env var isn't injected. */}
            <span
              style={{
                marginLeft: 10, fontSize: 10, fontWeight: 500,
                color: 'var(--text-muted)', fontFamily: 'monospace',
                background: '#f3f4f6', padding: '2px 6px', borderRadius: 3,
              }}
              title={`Branch: ${import.meta.env.VITE_BRANCH || 'local'}`}
            >
              build:{(import.meta.env.VITE_COMMIT_SHA || 'dev').slice(0, 7)}
            </span>
          </div>
          {current?.ocrDone && (
            <div className="edit-mode-bar" role="tablist">
              <ModeBtn label="문장 수정" active={editMode === 'sentence'} onClick={() => setEditMode('sentence')} />
              <ModeBtn label="단어 수정" active={editMode === 'word'} onClick={() => setEditMode('word')} />
              <ModeBtn label="텍스트 삭제" danger active={editMode === 'delete-text'} onClick={() => setEditMode('delete-text')} />
              <ModeBtn label="영역 삭제" danger active={editMode === 'delete-area'} onClick={() => setEditMode('delete-area')} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="btn sm"
              disabled={!undoStack.current.length || busy}
              onClick={undo}
              title="되돌리기 (Ctrl+Z)"
            >↶ 되돌리기</button>
            <button
              className="btn sm"
              disabled={!redoStack.current.length || busy}
              onClick={redo}
              title="다시 실행 (Ctrl+Shift+Z / Ctrl+Y)"
            >↷ 다시 실행</button>
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
            <button className="btn sm" disabled={!current || busy} onClick={exportCurrentPng}>PNG 다운로드</button>
            <button className="btn primary sm" disabled={!pages.length || busy} onClick={exportPdf}>PDF 다운로드</button>
            {pages.length > 1 && (
              <button className="btn sm" disabled={!pages.length || busy} onClick={exportAllZip}>전체 ZIP</button>
            )}
          </div>
        </div>
        {/* Hancom-style properties toolbar — memoised so it only re-renders
            when the SELECTED layer's relevant fields change, never on
            drag/move of any other layer. Replaces the heavy right panel. */}
        {current?.ocrDone && (
          <PropertiesToolbar
            layer={selectedLayer}
            fontOptions={FONT_OPTIONS}
            onUpdate={update}
            onMutateStart={pushHistory}
            onDelete={() => selectedLayer && softDeleteLayer(selectedLayer.id)}
          />
        )}
        <div className="canvas-area">
          {current ? (
            <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
              <canvas
                ref={previewRef}
                style={{
                  maxWidth: '100%',
                  height: 'auto',
                  display: 'block',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                }}
              />
              {current.ocrDone && (
                <TextLayersOverlay
                  layers={current.layers}
                  eraseRegions={current.eraseRegions || []}
                  scale={dispScale}
                  selectedId={selectedLayerId}
                  onSelect={setSelectedLayerId}
                  onUpdate={update}
                  editMode={editMode}
                  onDeleteLayer={softDeleteLayer}
                  onAreaErase={addEraseRegion}
                  onAreaEraseDelete={removeEraseRegion}
                  onMutateStart={pushHistory}
                  onDragActiveChange={handleDragActiveChange}
                  onEditingChange={setEditingLayerId}
                />
              )}
            </div>
          ) : (
            <div className="empty-hero"><div className="big">✎</div><h2>텍스트 편집</h2><p>이미지 또는 PDF를 업로드해 텍스트를 인식하고 동일 폰트로 수정하세요. PDF는 전체 페이지 자동 처리.</p></div>
          )}
        </div>
        {busy && (
          <div className="progress-bar-overlay">
            <div className="label">{progressLabel || '처리 중'}</div>
            <div className={'progress bar' + (progress > 0 ? '' : ' indeterminate')}>
              <div style={{ width: `${progress > 0 ? progress : 100}%` }} />
            </div>
            <div className="pct">{progress > 0 ? `${progress}%` : ''}</div>
          </div>
        )}
      </div>

      {confirmState && (
        <ConfirmDialog
          message={confirmState.message}
          detail={confirmState.detail}
          onYes={confirmState.onYes}
          onNo={confirmState.onNo}
        />
      )}
    </div>
  );
}

function stripExt(s) { return (s || '').replace(/\.[^.]+$/, ''); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Memoised page-thumbnail card. The previous inline implementation called
// `p.canvas.toDataURL()` on every render — and the parent re-renders on every
// drag mousemove (each layer patch produces a new `pages` array). For a 10-
// page PDF rendered at 2× scale that was 10 base64 encodes per frame, the
// dominant frame-drop source while editing.
//
// dataURL is now cached per canvas REFERENCE in a WeakMap, so:
//   - The first render of a page pays the encode cost once.
//   - Subsequent renders reuse the cached string.
//   - When the canvas reference changes (rare — only on page replace) the
//     cache entry naturally drops.
// React.memo with a shallow check on `page === prev.page` skips even the
// reconciliation work for unchanged thumbs.
const _thumbUrlCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
function getThumbUrl(canvas) {
  if (!canvas) return '';
  if (!_thumbUrlCache) return canvas.toDataURL();
  let url = _thumbUrlCache.get(canvas);
  if (!url) {
    url = canvas.toDataURL();
    _thumbUrlCache.set(canvas, url);
  }
  return url;
}
const PageThumb = memo(function PageThumb({ page, pageIdx, active }) {
  const editedCount = page.ocrDone ? page.layers.filter((l) => l.edited).length : 0;
  return (
    <div className={'thumb' + (active ? ' active' : '')} data-page-idx={pageIdx}>
      <div className="pic">
        <img src={getThumbUrl(page.canvas)} alt="" />
      </div>
      <div className="meta">
        <b>Page {page.pageNum}</b>
        <small style={{ color: page.ocrDone ? 'var(--success)' : 'var(--text-muted)' }}>
          {page.ocrDone ? `텍스트 ${page.layers.length}개 · 편집 ${editedCount}` : 'OCR 미실행'}
        </small>
      </div>
    </div>
  );
}, (prev, next) => (
  prev.page === next.page &&
  prev.pageIdx === next.pageIdx &&
  prev.active === next.active
));

// Sentence-level merge pass over a layer list. Adjacent layers in the same
// visual line are collapsed into one editable run when they share enough
// typographical state to reasonably represent one phrase:
//   - same fontFamily + fontWeight + fontSize (± 1 px)
//   - similar baseY (± 25 % of fontSize)
//   - same colour
//   - horizontal gap ≤ 1.2 × fontSize  (≈ one-glyph spacer)
//   - not flagged vertical
// The merged layer:
//   - inherits the typographical fields of the leftmost fragment,
//   - joins the texts with a single space when not already adjacent,
//   - extends the bbox to the union of the inputs,
//   - rebuilds the per-word list across the joined text so word-level
//     selection still pinpoints the original glyph the user clicked.
// Drop overlapping-bbox duplicate layers. Some PDFs emit the same visual
// text TWICE in their content stream:
//   - once as visible glyphs with a custom CMap (the layer the eye sees),
//   - once as an invisible accessibility / "ActualText" overlay carrying
//     the real Unicode at zero ink opacity.
// pdfjs returns BOTH as text items at near-identical bboxes, so both
// turn into editable layers — and the user ends up editing one while
// the other still shows up in the next render.
//
// Heuristic: when two layers' bboxes overlap by ≥ 60 % of the smaller
// rect's area, treat them as duplicates. Keep the one with the cleaner
// text (not garble-flagged); on a tie, keep the longer string.
function dedupOverlappingLayers(layers) {
  if (!layers || layers.length < 2) return layers;
  const drop = new Set();
  for (let i = 0; i < layers.length; i++) {
    if (drop.has(i)) continue;
    const a = layers[i];
    for (let j = i + 1; j < layers.length; j++) {
      if (drop.has(j)) continue;
      const b = layers[j];
      const ax2 = a.x + a.w, ay2 = a.y + a.h;
      const bx2 = b.x + b.w, by2 = b.y + b.h;
      const ix0 = Math.max(a.x, b.x), iy0 = Math.max(a.y, b.y);
      const ix1 = Math.min(ax2, bx2), iy1 = Math.min(ay2, by2);
      const inter = (ix1 > ix0 && iy1 > iy0) ? (ix1 - ix0) * (iy1 - iy0) : 0;
      const aArea = Math.max(1, a.w * a.h);
      const bArea = Math.max(1, b.w * b.h);
      const overlap = inter / Math.min(aArea, bArea);

      // Primary check: substantial area overlap. Lowered from 0.6 to 0.45 —
      // pdfjs's invisible ActualText overlay frequently sits at a slightly
      // different baseline than the visible-glyph item (the invisible layer
      // uses the FONT'S OWN ascent/descent metrics while the visible layer
      // sits where the glyph ink actually lives), so the bbox overlap stays
      // below 60 % even though they refer to the same word.
      let duplicate = overlap >= 0.45;

      // Secondary check: baseline + horizontal-extent overlap. Two items
      // that share the same baseline within 2 px AND whose X-ranges
      // overlap by ≥ 70 % of the shorter run are almost always the
      // visible-glyph + invisible-ActualText pair. Catches the case the
      // area test misses when the invisible overlay has a slightly
      // different y0 / y1.
      if (!duplicate) {
        const baseA = a.baseY ?? (a.y + a.h);
        const baseB = b.baseY ?? (b.y + b.h);
        const baselineMatch = Math.abs(baseA - baseB) <= 2;
        const xOver = (ix1 > ix0) ? (ix1 - ix0) : 0;
        const minWidth = Math.max(1, Math.min(a.w, b.w));
        if (baselineMatch && xOver / minWidth >= 0.7) duplicate = true;
      }

      if (!duplicate) continue;

      // Pick the survivor — prefer non-garbled, then longer, then bigger.
      const aGarbled = typeof looksGarbledKorean === 'function' && looksGarbledKorean(a.text);
      const bGarbled = typeof looksGarbledKorean === 'function' && looksGarbledKorean(b.text);
      let dropIdx;
      if (aGarbled && !bGarbled) dropIdx = i;
      else if (bGarbled && !aGarbled) dropIdx = j;
      else if ((a.text || '').length !== (b.text || '').length) {
        dropIdx = (a.text || '').length >= (b.text || '').length ? j : i;
      } else {
        dropIdx = aArea >= bArea ? j : i;
      }
      drop.add(dropIdx);
      if (dropIdx === i) break;     // 'a' is gone, restart with next i
    }
  }
  return layers.filter((_, i) => !drop.has(i));
}

function mergeAdjacentLayers(layers) {
  if (!layers || layers.length < 2) return layers;
  // Sort top-to-bottom, then left-to-right — we only attempt merges within
  // a single horizontal band so this ordering is what we want.
  const sorted = layers.slice().sort((a, b) => {
    const dy = (a.baseY || a.y) - (b.baseY || b.y);
    if (Math.abs(dy) > 2) return dy;
    return a.x - b.x;
  });
  const out = [];
  for (const cur of sorted) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && canMerge(last, cur)) {
      const gap = cur.x - (last.x + last.w);
      const joiner = gap > Math.max(2, last.fontSize * 0.15) ? ' ' : '';
      const text = `${last.text}${joiner}${cur.text}`;
      const x0 = Math.min(last.x, cur.x);
      const x1 = Math.max(last.x + last.w, cur.x + cur.w);
      const y0 = Math.min(last.y, cur.y);
      const y1 = Math.max(last.y + last.h, cur.y + cur.h);
      const baseY = Math.max(last.baseY ?? last.y + last.h, cur.baseY ?? cur.y + cur.h);
      // Rebuild words: take existing per-word bboxes, then shift by the
      // joiner-induced offset. Since both inputs already had absolute canvas
      // coordinates inside `.words`, we can just concat.
      const words = [...(last.words || []), ...(cur.words || [])];
      const merged = {
        ...last,
        text,
        originalText: `${last.originalText || last.text}${joiner}${cur.originalText || cur.text}`,
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
        originalX: x0,
        originalY: y0,
        originalW: x1 - x0,
        originalH: y1 - y0,
        baseY,
        ascent: (y1 - y0) * 0.92,
        descent: (y1 - y0) * 0.08,
        words,
      };
      out[out.length - 1] = merged;
    } else {
      out.push(cur);
    }
  }
  return out;
}
function canMerge(a, b) {
  if (a.isVertical || b.isVertical) return false;
  if (a.angleDeg || b.angleDeg) return false;
  if (a.fontFamily !== b.fontFamily) return false;
  // fontWeight差: deliberately NOT a merge-blocker. A common case is a
  // single visual sentence whose middle fragment is bolder (e.g.
  // "● 식권대장 감소(-87)의 **63%가 검색광고**(-55)…"). PDF emits the
  // bold fragment as a separate item with a different weight; if we
  // refused to merge it, the line ends up split into 3 layers (the
  // exact "한 줄이 잘려서 인식되는" complaint). The merged layer takes
  // the LEFT fragment's weight; rendering after edit therefore loses
  // the per-word bold styling, but the user can re-apply bold to
  // sub-words via the B button if needed. Keeping the line unified is
  // the stated priority.
  if (Math.abs((a.fontSize || 0) - (b.fontSize || 0)) > 1) return false;
  const baseA = a.baseY ?? a.y + a.h;
  const baseB = b.baseY ?? b.y + b.h;
  const fz = Math.max(a.fontSize || 0, b.fontSize || 0, 1);
  if (Math.abs(baseA - baseB) > fz * 0.25) return false;
  if ((a.color || '') !== (b.color || '')) return false;
  // Sentence-final guard. If `a` ends with sentence-terminal punctuation
  // (".", "!", "?", "。", "다.", "요.") we don't extend it with the next
  // fragment even if everything else lines up — it's a NEW sentence in the
  // same line and the user wants to edit it independently.
  const aText = (a.text || '').trim();
  const bText = (b.text || '').trim();
  if (/[.!?。]$/.test(aText) || /(다|요)\.$/.test(aText)) return false;
  // Parenthetical-label guard. "(VAT포함)" sitting next to a regular run
  // should stay its own layer — the user wants per-label selection.
  if (/^[(（[].+[)）\]]\s*$/.test(bText)) return false;
  if (/^[(（[].+[)）\]]\s*$/.test(aText)) return false;
  // Table-cell guard — refuse to merge a standalone short number/token with
  // the next run. In tabular layouts the "No" / index column is emitted as
  // a tiny item ("1", "4", "11") that sits one cell-gap away from the
  // longer product-name run. Without this guard the gap stays under our
  // x-threshold and the two get joined, producing one editable layer that
  // spans the column boundary (visible as a comically-wide edit box). A
  // numeric label is never the start of a Korean sentence, so a hard rule
  // is safe.
  if (/^\d{1,3}[.)]?$/.test(aText)) return false;
  // x-ordering: b must sit to the right of a, with a gap small enough to
  // be an in-sentence spacer. Back at 1.2 em — the previous tighter 0.7-em
  // value split single Korean sentences (full-width word-space ≈ 1 em)
  // into 3+ layers, the "한 줄 문장이 3개 영역으로 잡힘" regression. The
  // standalone-numeric guard above already catches the row-number column
  // case (the "4" + "프리미엄 원두 …" merge), so we don't also need a
  // tighter gap.
  const gap = b.x - (a.x + a.w);
  if (gap < -2) return false;             // overlapping → don't touch
  if (gap > fz * 1.2) return false;       // too far apart
  return true;
}


let _layerMeasureCtx = null;
// Measure the rendered glyph width of a layer using its actual font, size and
// weight — same string the canvas will use when drawTextOverlay redraws.
// Returns canvas-px width with a small breathing pad. Layer width is updated
// in update() so the bbox grows / shrinks with text changes in real time.
function measureLayerWidth(l) {
  if (typeof document === 'undefined') return l.w;
  if (!_layerMeasureCtx) _layerMeasureCtx = document.createElement('canvas').getContext('2d');
  const ctx = _layerMeasureCtx;
  const size = Math.max(4, +l.fontSize || 14);
  const weight = +l.fontWeight || 400;
  ctx.font = `${weight} ${size}px ${l.fontFamily || 'sans-serif'}`;
  if (l.letterSpacing) {
    try { ctx.letterSpacing = `${l.letterSpacing}px`; } catch {}
  } else {
    try { ctx.letterSpacing = '0px'; } catch {}
  }
  const measured = ctx.measureText(l.text || ' ').width;
  const lsFallback = (l.letterSpacing && !('letterSpacing' in ctx))
    ? l.letterSpacing * Math.max(0, (l.text || '').length - 1)
    : 0;
  // Right-side breathing room scaled with font size — measureText returns
  // glyph ADVANCE width, but the actual ink can extend past it by a side-
  // bearing fraction (worst case ~25 % of fontSize for bold display faces).
  // Without enough margin the right-most glyph gets clipped after edit.
  const trailPad = Math.max(8, Math.round(size * 0.25));
  return Math.max(20, Math.ceil(measured + lsFallback + trailPad));
}

// Per-word bbox synthesis using ctx.measureText against the layer's actual
// font / size / weight. Replaces the previous uniform-char-width approach,
// which treated every glyph as the same width — fine for Korean (mostly
// fullwidth) but off by 20–40 % for proportional Latin fonts where "i" /
// "m" / "W" differ in width. The measured version walks the string once,
// summing advance widths, so word boundaries land exactly under the
// rendered glyph in the editor.
//
// Falls back to uniform spacing when document / canvas is unavailable
// (SSR-style environments) so the synthesis never throws.
function synthWordsMeasured(text, x, y, w, h, style) {
  if (!text) return [];
  if (typeof document === 'undefined') return synthWordsUniform(text, x, y, w, h);
  const ctx = (window._synthWordsCtx ||= document.createElement('canvas').getContext('2d'));
  const size = Math.max(4, +style?.fontSize || 14);
  const weight = +style?.fontWeight || 400;
  const family = style?.fontFamily || 'sans-serif';
  ctx.font = `${weight} ${size}px ${family}`;
  if (style?.letterSpacing) {
    try { ctx.letterSpacing = `${style.letterSpacing}px`; } catch {}
  } else {
    try { ctx.letterSpacing = '0px'; } catch {}
  }
  // Measured advance widths can drift from the original PDF advances by a
  // few percent because the matched web font isn't byte-identical to the
  // embedded face. Scale measured widths so the sum lines up with the
  // detected layer width — keeps word boundaries inside the visible cell.
  const naturalSum = ctx.measureText(text).width || 1;
  const scale = w / naturalSum;
  const parts = text.split(/(\s+)/);
  const out = [];
  let cursorX = x;
  for (const part of parts) {
    if (!part) continue;
    const advance = ctx.measureText(part).width * scale;
    if (!/^\s+$/.test(part)) {
      out.push({
        text: part,
        bbox: { x0: cursorX, y0: y, x1: cursorX + advance, y1: y + h },
      });
    }
    cursorX += advance;
  }
  return out;
}
function synthWordsUniform(text, x, y, w, h) {
  if (!text) return [];
  const charW = w / Math.max(1, text.length);
  const out = [];
  const parts = text.split(/(\s+)/);
  let cursor = 0;
  for (const part of parts) {
    if (part && !/^\s+$/.test(part)) {
      out.push({
        text: part,
        bbox: {
          x0: x + cursor * charW,
          y0: y,
          x1: x + (cursor + part.length) * charW,
          y1: y + h,
        },
      });
    }
    cursor += part.length;
  }
  return out;
}

// Re-split a Tesseract line into per-VISUAL-ROW pseudo-lines. PSM 6
// sometimes bundles vertically stacked text in the same column (a multi-
// line table cell) into ONE OCR line — that's how a 3-line product
// description ended up with a bbox 3× the actual line height, and why
// guessFont reported fontSize 100+ for what was really 30 px text.
// Cluster words by their TOP y-coordinate: anything that jumps by more
// than ~0.7 × median word height starts a new row.
function splitOcrLineByRows(line) {
  const words = ((line.words) || []).filter((w) => w && w.bbox && w.text && w.text.trim());
  if (words.length <= 1) return [line];

  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const heights = sorted.map((w) => w.bbox.y1 - w.bbox.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 1;
  // Aggressive row split — 0.55 × median word height. Korean text rows
  // commonly sit within 1.2 line-heights of each other, so the previous
  // 0.7 missed adjacent-row pairs whose vertical gap was just under
  // 70 % of the glyph height. With 0.55 we still ignore the natural
  // baseline jitter inside a single OCR line (Korean glyphs vary by
  // 1–2 px due to the round-up in the adaptive classifier) while
  // catching real row breaks earlier.
  const threshold = medianH * 0.55;

  const rows = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = rows[rows.length - 1];
    const avgPrevTop = prev.reduce((s, w) => s + w.bbox.y0, 0) / prev.length;
    if (sorted[i].bbox.y0 - avgPrevTop > threshold) {
      rows.push([sorted[i]]);
    } else {
      prev.push(sorted[i]);
    }
  }
  if (rows.length === 1) return [line];

  return rows.map((rowWords) => {
    rowWords.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const x0 = Math.min(...rowWords.map((w) => w.bbox.x0));
    const y0 = Math.min(...rowWords.map((w) => w.bbox.y0));
    const x1 = Math.max(...rowWords.map((w) => w.bbox.x1));
    const y1 = Math.max(...rowWords.map((w) => w.bbox.y1));
    return {
      text: rowWords.map((w) => w.text).join(' '),
      bbox: { x0, y0, x1, y1 },
      confidence: line.confidence,
      words: rowWords,
      font_size: line.font_size,
      is_bold: line.is_bold,
      is_italic: line.is_italic,
      is_serif: line.is_serif,
      is_monospace: line.is_monospace,
    };
  });
}

// Re-split a Tesseract line into per-cell pseudo-lines. Tesseract groups
// every word with a similar baseline into the SAME line, so a table row
// containing several cells comes back as one line whose `words` array holds
// the union — separated by huge x-gaps where the vertical column rules
// would have been. We cluster those words on x-gap to recover the cells.
//
// Threshold = max(4 × median word gap, 1.5 × line height). The median-gap
// term scales with the row's natural inter-word spacing; the line-height
// term gives a sensible floor for lines with only 2-3 words (where a
// median is meaningless).
function splitOcrLineByCells(line) {
  const words = ((line.words) || []).filter((w) => w && w.bbox && w.text && w.text.trim());
  if (words.length <= 1) return [line];

  words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    gaps.push(words[i].bbox.x0 - words[i - 1].bbox.x1);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const lineHeight = Math.max(1, line.bbox.y1 - line.bbox.y0);
  const threshold = Math.max(4 * Math.max(median, 1), lineHeight * 1.5);

  const cells = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
    if (gap > threshold) {
      cells.push([words[i]]);
    } else {
      cells[cells.length - 1].push(words[i]);
    }
  }
  if (cells.length === 1) return [line]; // no cell boundaries found

  return cells.map((cellWords) => {
    const x0 = Math.min(...cellWords.map((w) => w.bbox.x0));
    const y0 = Math.min(...cellWords.map((w) => w.bbox.y0));
    const x1 = Math.max(...cellWords.map((w) => w.bbox.x1));
    const y1 = Math.max(...cellWords.map((w) => w.bbox.y1));
    return {
      text: cellWords.map((w) => w.text).join(' '),
      bbox: { x0, y0, x1, y1 },
      confidence: line.confidence,
      words: cellWords,
      // Preserve Tesseract's font_size if present so guessFont uses the
      // line-level metric rather than re-deriving from the smaller cell
      // bbox height (which could underestimate for short cell text).
      font_size: line.font_size,
      is_bold: line.is_bold,
      is_italic: line.is_italic,
      is_serif: line.is_serif,
      is_monospace: line.is_monospace,
    };
  });
}

// Paint all per-page mutations onto an already-base-rendered canvas. Ordering:
//   1. Erase the ORIGINAL footprint of any layer that has been deleted, moved
//      (without content change), edited (text changed), or whose colour was
//      altered — so original glyphs never appear twice.
//   2. For move-only layers, lift the original glyph bitmap straight from the
//      source canvas and re-paste it at the new position. NO font rendering →
//      typography metric, kerning, and Korean glyph widths are byte-perfect.
//   3. For edited layers, rasterise the new text with the matched web font.
//   4. Paint user-drawn area-erase rectangles last so they always win.
function renderEdits(ctx, p, editingLayerId) {
  const src = p.canvas;
  for (const l of p.layers) {
    // Editing layer ALWAYS gets erased — even before the first keystroke —
    // so the user never sees the canvas-rendered original peeking through
    // the opaque <input>. Without this, opening the editor briefly shows
    // the old glyphs underneath until `l.edited` flips true on first input.
    const isEditing = editingLayerId && l.id === editingLayerId;
    const needsErase = l.deleted || l.edited || (l.moved && !l.deleted) || isEditing;
    if (!needsErase) continue;
    // Erase rect = UNION of (original glyph footprint) ∪ (new draw extent)
    // with generous padding. Previous versions used only the pixel-tight
    // extent and stopped at `originalW` horizontally — that left two
    // failure modes visible to the user:
    //   1) When pdfjs returned a font whose glyph ink extended ABOVE the
    //      reported tight box (PUA-mapped Korean glyphs render at the
    //      font's true ascent, not the bbox we computed), an ascender
    //      sliver remained over the new text.
    //   2) When the user typed text WIDER than the original, the right
    //      end of the OLD glyph wasn't fully wiped — for an OCR'd page
    //      the original glyph extends to wordRight which may exceed
    //      originalW after we re-tightened it; for a deletion-only flow
    //      moving text away, the destination area lacks erase too.
    // Using the FULL line-box (originalY..originalY+originalH) plus an
    // em-scaled padding covers ascender ink reliably; unioning with the
    // current rect handles the wider-edit case.
    const fz = +l.fontSize || 14;
    const PAD_X = Math.max(4, Math.round(fz * 0.30));
    const PAD_Y = Math.max(3, Math.round(fz * 0.25));
    const ox = (l.originalX ?? l.x);
    const oy = (l.originalY ?? l.y);
    const ow = (l.originalW ?? l.w);
    const oh = (l.originalH ?? l.h);
    // Vertical coverage: union of line-box and pixel-tight extent
    // (whichever is taller) — covers PUA-tall ink AND prevents bleed
    // into adjacent rows when the tight scan was accurate.
    const topTight = (l.glyphTop != null ? l.glyphTop : oy);
    const botTight = (l.glyphBottom != null ? l.glyphBottom : (oy + oh));
    const eraseTop = Math.min(oy, topTight) - PAD_Y;
    const eraseBot = Math.max(oy + oh, botTight) + PAD_Y;
    // Horizontal coverage: union of original footprint and current rect
    // (handles edited-wider-than-original and moved-then-edited cases).
    const cx = l.x, cw = l.w;
    const eraseLeft  = Math.min(ox, cx) - PAD_X;
    const eraseRight = Math.max(ox + ow, cx + cw) + PAD_X;
    ctx.fillStyle = l.bgColor || '#ffffff';
    ctx.fillRect(eraseLeft, eraseTop, eraseRight - eraseLeft, eraseBot - eraseTop);
  }
  for (const l of p.layers) {
    if (l.deleted || l.edited || l.visible === false) continue;
    if (!l.moved) continue;
    // Lift the original glyph pixels and place them at the new position.
    // Source rect = pixel-tight extent + a generous LIFT_PAD on ALL sides.
    // The pad has to cover:
    //   • Korean final consonants (ㄱ/ㄴ/ㅁ/ㅂ) whose ink sits exactly at
    //     glyphBottom — sub-pixel anti-aliasing on that edge falls outside
    //     the pixel-tight rect from tightenBBoxToGlyphs and is lost on
    //     drawImage ("식"→"신", "분"→"부" bug);
    //   • bold-face glyphs whose side-bearing extends past originalX/W;
    //   • the diacritic-like Korean glyph parts (ㅑ ㅕ ㅛ) that ride
    //     slightly above the baseline cluster.
    // 2 px was insufficient; 6 px covers worst-case anti-aliased tails at
    // 2× canvas scaling without dragging in adjacent row text.
    const LIFT_PAD = 6;
    const rawSx   = l.originalX ?? l.x;
    const rawSw   = l.originalW ?? l.w;
    const rawSy   = (l.glyphTop    != null ? l.glyphTop    : (l.originalY ?? l.y));
    const rawSBot = (l.glyphBottom != null ? l.glyphBottom : ((l.originalY ?? l.y) + (l.originalH ?? l.h)));
    const sx = Math.max(0, rawSx - LIFT_PAD);
    const sw = Math.min(src.width - sx, (rawSx + rawSw) - sx + LIFT_PAD);
    const sy = Math.max(0, rawSy - LIFT_PAD);
    const sBot = Math.min(src.height, rawSBot + LIFT_PAD);
    const sh = Math.max(1, sBot - sy);
    // Destination shifts by the same pad so the lifted glyph ink lands
    // EXACTLY at the new line-box top (the extra padding pixels just
    // extend past the box invisibly). dx/dy = new_box_corner − pad.
    const dx = l.x + (sx - rawSx);
    const dy = l.y + (sy - (l.originalY ?? l.y));
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, sw, sh);
  }
  for (const l of p.layers) {
    if (l.deleted || !l.edited || l.visible === false) continue;
    // Skip the editing layer — its inline <input> is the sole renderer
    // while the editor is open. Drawing here too produces a doubled
    // overlap (canvas glyphs behind input glyphs at a slightly different
    // baseline, the visible artefact from issues #1 & #2). On commit,
    // editingLayerId clears, scheduleRedraw fires, and the canvas takes
    // over the rendering cleanly.
    if (editingLayerId && l.id === editingLayerId) continue;
    drawTextOverlay(ctx, l);
  }
  for (const r of (p.eraseRegions || [])) {
    ctx.fillStyle = r.color || '#ffffff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
}

function ModeBtn({ label, active, danger, onClick }) {
  const base = {
    padding: '5px 10px', borderRadius: 5, fontSize: 12, fontWeight: 500,
    border: '1px solid var(--border)', cursor: 'pointer', background: '#fff',
    color: 'var(--text)', whiteSpace: 'nowrap',
  };
  const on = danger
    ? { background: '#ef4444', color: '#fff', borderColor: '#dc2626' }
    : { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' };
  return (
    <button type="button" onClick={onClick} style={{ ...base, ...(active ? on : {}) }}>
      {label}
    </button>
  );
}
function modeHint(mode) {
  if (mode === 'word') return '단어 클릭하여 편집';
  if (mode === 'delete-text') return '텍스트 클릭하여 삭제';
  if (mode === 'delete-area') return '드래그하여 영역 삭제';
  return '클릭=선택 · 드래그=이동 · 더블클릭=문장 편집';
}

function drawTextOverlay(ctx, l) {
  const fontSize = Math.max(4, Math.min(400, +l.fontSize || 14));
  const weight = +l.fontWeight || 400;
  ctx.save();
  // Clip the redraw to the union of the layer's ORIGINAL footprint and its
  // CURRENT bbox, with padding generous enough to cover ascender/descender
  // ink AND lateral side-bearing of bolder weights. The clip is what stops
  // the redraw from bleeding past the layer rect into neighbouring text;
  // the padding is what stops the redraw from CHOPPING off the bottom of
  // descenders ("g/p/y") or the right side of a bold glyph's overhang.
  {
    // Clip = union(original-footprint, current-rect) + generous em-scaled
    // padding. Padding has to be at least as large as the erase pass uses
    // in `renderEdits` (PAD_X ≈ 0.30 em, PAD_Y ≈ 0.25 em) plus headroom
    // for the actual fillText draw — bold faces and Korean glyphs paint
    // a few px past the advance width / line-box. Bumped to 0.55 em
    // vertical / 0.45 em horizontal so the new text never clips on edit.
    const PADC_V = Math.max(8, Math.round(fontSize * 0.55));
    const PADC_H = Math.max(8, Math.round(fontSize * 0.45));
    const cox = l.originalX ?? l.x, coy = l.originalY ?? l.y;
    const cow = l.originalW ?? l.w, coh = l.originalH ?? l.h;
    const cx = Math.min(cox, l.x) - PADC_H;
    const cy = Math.min(coy, l.y) - PADC_V;
    const cw = Math.max(cox + cow, l.x + l.w) - cx + PADC_H;
    const ch = Math.max(coy + coh, l.y + l.h) - cy + PADC_V;
    ctx.beginPath();
    ctx.rect(cx, cy, cw, ch);
    ctx.clip();
  }
  ctx.font = `${weight} ${fontSize}px ${l.fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  // Letter-spacing preservation: apply the layer's reconstructed Tc so glyph
  // advances match the original. Non-standard but supported in current
  // Chromium/Safari/Firefox; harmless try/catch on older browsers.
  if (l.letterSpacing) {
    try { ctx.letterSpacing = `${l.letterSpacing}px`; } catch {}
  } else {
    try { ctx.letterSpacing = '0px'; } catch {}
  }
  const m = ctx.measureText(l.text || ' ');
  const ascent = l.ascent || m.actualBoundingBoxAscent || fontSize * 0.82;
  const descent = l.descent || m.actualBoundingBoxDescent || fontSize * 0.18;
  const newW = m.width;
  // Baseline: prefer the layer's stored `baseY` (set from glyph-tight
  // detection at OCR time and refreshed when the layer moves). Falling
  // back to `l.y + l.ascent` keeps older layers without baseY working.
  // When the layer moved, `baseY` was stored in canvas-absolute pixels at
  // OCR time so we need to translate by (l.y − l.originalY).
  const moveDY = (l.y - (l.originalY ?? l.y));
  const baseY = (l.baseY != null) ? (l.baseY + moveDY) : (l.y + ascent);
  // Resolve text-align — shift the draw-X so center/right text sits inside
  // the layer rect without changing the bbox itself.
  const align = l.textAlign || 'left';
  let drawX = l.x;
  if (align === 'center') drawX = l.x + Math.max(0, (l.w - newW) / 2);
  else if (align === 'right') drawX = l.x + Math.max(0, l.w - newW);
  const newTop = baseY - ascent;
  const newBottom = baseY + descent;
  const PAD = 1;
  // Background is TRANSPARENT by default. The erase of the ORIGINAL
  // glyph footprint already happened in `renderEdits` (with a generous
  // line-box + new-extent union + em-scaled padding), so we don't
  // re-erase here — doing so with a smaller rect would actually be
  // counterproductive (it could re-paint inside the already-erased zone
  // and visually betray a slightly off-colour patch). The only fill we
  // still need is when the user has EXPLICITLY chosen a coloured
  // background for this layer.
  const eraseBg = l.bgColor || '#ffffff';
  const ox = l.originalX ?? l.x, oy = l.originalY ?? l.y;
  const ow = l.originalW ?? l.w, oh = l.originalH ?? l.h;
  if (l.bgColorEdited && l.bgColor) {
    const newLeft = l.x - PAD;
    const newRight = l.x + Math.max(l.w, Math.ceil(newW)) + PAD;
    const newTopP = Math.min(l.y, newTop) - PAD;
    const newBottomP = Math.max(l.y + l.h, newBottom) + PAD;
    if (newLeft < ox - PAD || newRight > ox + ow + PAD || newTopP < oy - PAD || newBottomP > oy + oh + PAD) {
      ctx.fillStyle = l.bgColor;
      ctx.fillRect(newLeft, newTopP, newRight - newLeft, newBottomP - newTopP);
    }
  }
  // Foreground: when contrast is dynamic, sample against the sampled page
  // background — that's what's actually behind the glyph after the erase
  // pass, not the (now-transparent) user bg.
  const fg = l.colorEdited ? (l.color || '#111111') : ensureContrast(l.color || '#111111', eraseBg);
  ctx.fillStyle = fg;
  // Apply transform: rotation around baseline-origin + synthetic italic skew.
  // Order matters — rotate first (per the PDF's text matrix), then skew so
  // the italic shear stays aligned to the glyph baseline.
  const needsTransform = l.angleDeg || l.skewXDeg;
  const drawOffsetX = drawX - l.x;
  if (needsTransform) {
    ctx.translate(l.x, baseY);
    if (l.angleDeg) ctx.rotate((l.angleDeg * Math.PI) / 180);
    if (l.skewXDeg) ctx.transform(1, 0, -Math.tan((l.skewXDeg * Math.PI) / 180), 1, 0, 0);
    ctx.fillText(l.text || '', drawOffsetX, 0);
  } else {
    ctx.fillText(l.text || '', drawX, baseY);
  }
  ctx.restore();
}
function ensureContrast(fg, bg) {
  const a = parseRgb(fg), b = parseRgb(bg);
  if (!a || !b) return fg;
  const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
  const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
  // Only override when the contrast is genuinely unreadable. A coloured
  // run (red warning text, blue link, etc.) can sit at a luminance close
  // to the page bg and still be perfectly legible because of the hue
  // difference — forcing it to black/white here was the cause of the
  // "글자 색상이 깨짐" symptom where red headings turned grey on commit.
  // 15 keeps the safety net for almost-invisible runs (near-white on
  // white) without touching any visually distinct colour.
  if (Math.abs(la - lb) < 15) return lb > 128 ? '#111111' : '#ffffff';
  return fg;
}
function parseRgb(s) {
  if (!s) return null;
  if (s.startsWith('#')) {
    const v = s.slice(1);
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
function sampleBg(canvas, bbox) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const bh = bbox.y1 - bbox.y0;
  const margin = Math.max(6, Math.round(bh * 0.6));
  const positions = [
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y0 - margin],
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y1 + margin],
    [bbox.x0 - margin, Math.round((bbox.y0 + bbox.y1) / 2)],
    [bbox.x1 + margin, Math.round((bbox.y0 + bbox.y1) / 2)],
  ];
  const samples = [];
  for (const [x, y] of positions) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    try {
      const p = ctx.getImageData(x, y, 1, 1).data;
      samples.push([p[0], p[1], p[2]]);
    } catch {}
  }
  if (!samples.length) return '#ffffff';
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return `rgb(${median(samples.map((s) => s[0]))},${median(samples.map((s) => s[1]))},${median(samples.map((s) => s[2]))})`;
}
function sampleFg(canvas, bbox, bgRgb) {
  const ctx = canvas.getContext('2d');
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  if (w < 2 || h < 2) return '#111111';
  const bg = parseRgb(bgRgb) || [255, 255, 255];
  const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  try {
    const data = ctx.getImageData(bbox.x0, bbox.y0, w, h).data;
    const darkerExpected = bgLum > 128;
    let r=0,g=0,b=0,n=0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      const diff = darkerExpected ? bgLum - lum : lum - bgLum;
      if (diff > 50) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
    }
    if (!n) return darkerExpected ? '#111111' : '#ffffff';
    return `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`;
  } catch { return '#111111'; }
}
function rgbToHex(s) {
  if (!s) return '#000000';
  if (s.startsWith('#')) return s;
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
}
