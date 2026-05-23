import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { loadImage, fileToDataURL, canvasToBlob } from '../../utils/image';
import { recognizeImage, guessFont, matchPdfFont, buildFontFamilyChain, suppressTableLines } from '../../utils/ocr';
import { loadPdfJs, renderPageToCanvas, downloadBlob, extractPageTextItems } from '../../utils/pdf';
import { PDFDocument } from 'pdf-lib';
import { useFontsReady } from '../../utils/fonts';
import { SYSTEM_FONTS } from '../../utils/ocr';
import TextLayersOverlay from '../../components/TextLayersOverlay';
import PropertiesToolbar from '../../components/PropertiesToolbar';
import ConfirmDialog from '../../components/ConfirmDialog';

const FONT_OPTIONS = SYSTEM_FONTS;

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
  const [, forceRerender] = useState(0);
  const bumpHistoryUi = () => forceRerender((n) => n + 1);

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

  // Auto-scroll the right panel to bring the selected layer's card to the top
  // whenever the canvas selection changes.
  useEffect(() => {
    if (!selectedLayerId) return;
    const el = document.getElementById(`layer-card-${selectedLayerId}`);
    if (!el) return;
    // Find the nearest scrollable ancestor (the right .panel) and scroll the
    // card to its top, leaving a small breathing margin.
    let scroller = el.parentElement;
    while (scroller && scroller !== document.body) {
      const cs = getComputedStyle(scroller);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') break;
      scroller = scroller.parentElement;
    }
    if (scroller) {
      const sRect = scroller.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      const delta = eRect.top - sRect.top - 8;
      scroller.scrollBy({ top: delta, behavior: 'smooth' });
    }
  }, [selectedLayerId]);

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
          let pdfText = null;
          try {
            pdfText = await extractPageTextItems(pdf, i, 2);
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
      const layers = page.pdfText.items
        .filter((it) => {
          const t = (it.text || '').trim();
          if (!t) return false;
          if (it.w < 2 || it.h < 4) return false;
          return /[a-zA-Z0-9가-힣]|[^ -]/.test(t);
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
          const bbox = {
            x0: Math.max(0, Math.floor(it.x)),
            y0: Math.max(0, Math.floor(it.y)),
            x1: Math.min(page.canvas.width, Math.ceil(it.x + it.w)),
            y1: Math.min(page.canvas.height, Math.ceil(it.y + it.h)),
          };
          const bg = sampleBg(page.canvas, bbox);
          const fg = sampleFg(page.canvas, bbox, bg);
          const isKorean = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(it.text);
          // Family chain: PDF-embedded font (pdfjs-registered) → matched web
          // font (with its own fallbacks) → Korean OS fallbacks → generic.
          const fontFamily = buildFontFamilyChain({
            pdfFamily: it.pdfFamily,
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
          return {
            id: crypto.randomUUID(),
            text: it.text,
            originalText: it.text,
            x: it.x,
            y: it.y,
            w: it.w,
            h: it.h,
            originalX: it.x,
            originalY: it.y,
            originalW: it.w,
            originalH: it.h,
            baseY: it.baseY,
            ascent: it.ascent,
            descent: it.descent,
            angleDeg: it.angleDeg || 0,
            skewXDeg: it.skewXDeg || 0,
            letterSpacing,
            lineHeight: it.fontSize, // single-line PDF item: line-height equals font-size
            pdfFamily: it.pdfFamily || '',
            fontFamily,
            fontName: m.font.name,
            fontSize: it.fontSize,
            fontWeight: m.weight,
            // PDF source: bold/italic is inferred from the font name and the
            // matrix shear we already extracted. Stored on the layer so the
            // right-panel B / I toggles and the re-render path agree.
            isBold: m.weight >= 600 || /bold|black|heavy|semibold|demi/i.test(it.fontName),
            isItalic: !!it.skewXDeg || /italic|oblique/i.test(it.fontName),
            color: fg,
            bgColor: bg,
            // Synthesise per-word bboxes inside the layer's tight rect so
            // 단어 수정 mode can target a specific word within a multi-word
            // sentence cell. Uniform char-width estimation — same approach
            // as splitAtCellGaps, doesn't depend on font measurement.
            words: synthWords(it.text, it.x, it.y, it.w, it.h),
            visible: true,
            edited: false,
            source: 'pdf',
          };
        });
      onProg?.({ progress: 0.95, stage: '레이어 적용 중' });
      await sleep(40);
      setPages((ps) => ps.map((p, i) => (i === pageIdx ? { ...p, layers, ocrDone: true } : p)));
      onProg?.({ progress: 1, stage: '완료' });
      return;
    }

    // Fallback: rasterized OCR for scans / image-only PDFs / images.
    onProg?.({ stage: 'Tesseract OCR 인식 중' });
    // Line-suppressed copy of the page canvas — table borders masked out so
    // text crossing or hugging a rule doesn't get clipped by Tesseract. The
    // original canvas is preserved for colour sampling and final rendering.
    const ocrInput = suppressTableLines(page.canvas);
    const data = await recognizeImage(ocrInput, onProg);

    // Sentence-level grouping: one layer per LINE. Tesseract gives `lines`
    // already at sentence/visual-line granularity, which is what the user
    // edits as a unit. Word-level access is still available via the "단어 수정"
    // mode in the canvas toolbar — that mode estimates the clicked-word
    // boundary inside the line and pre-selects it in the input. This avoids
    // over-fragmenting the document into one-frame-per-word.
    const rawLines = data.lines || [];
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
      // Suspiciously wide-aspect single-token results are usually a thin
      // horizontal rule that survived suppression and got OCR'd into one
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
      layers.push({
        id: crypto.randomUUID(),
        text,
        originalText: text,
        x: line.bbox.x0,
        y: line.bbox.y0,
        w: lbw,
        h: lbh,
        originalX: line.bbox.x0,
        originalY: line.bbox.y0,
        originalW: lbw,
        originalH: lbh,
        baseY: line.bbox.y1,
        ascent: lbh * 0.82,
        descent: lbh * 0.18,
        angleDeg: 0,
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
    setPages((ps) => ps.map((p, i) => (i === pageIdx ? { ...p, layers, ocrDone: true } : p)));
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

  useEffect(() => {
    if (!current || !previewRef.current) return;
    const c = previewRef.current;
    c.width = current.canvas.width;
    c.height = current.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(current.canvas, 0, 0);
    renderEdits(ctx, current);
  }, [current, currentIdx, pages, fontsTick]);

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
            <div className="thumb-list">
              {pages.map((p, i) => (
                <div
                  key={p.id}
                  className={'thumb' + (i === currentIdx ? ' active' : '')}
                  onClick={() => setCurrentIdx(i)}
                >
                  <div className="pic">
                    <img src={p.canvas.toDataURL()} alt="" />
                  </div>
                  <div className="meta">
                    <b>Page {p.pageNum}</b>
                    <small style={{ color: p.ocrDone ? 'var(--success)' : 'var(--text-muted)' }}>
                      {p.ocrDone ? `텍스트 ${p.layers.length}개 · 편집 ${p.layers.filter((l) => l.edited).length}` : 'OCR 미실행'}
                    </small>
                  </div>
                </div>
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
                  onUpdate={(id, patch) => update(id, patch)}
                  editMode={editMode}
                  onDeleteLayer={softDeleteLayer}
                  onAreaErase={addEraseRegion}
                  onAreaEraseDelete={removeEraseRegion}
                  onMutateStart={pushHistory}
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
  // Tc fallback for browsers without ctx.letterSpacing support.
  const lsFallback = (l.letterSpacing && !('letterSpacing' in ctx))
    ? l.letterSpacing * Math.max(0, (l.text || '').length - 1)
    : 0;
  return Math.max(20, Math.ceil(measured + lsFallback + 6));
}

// Per-word bbox synthesis with uniform char-width. Powers 단어 수정 mode
// for PDF-source layers (OCR layers get real per-word bboxes from
// Tesseract's line.words array). Imperfect for proportional fonts but
// always within a few px — accurate enough that the click-to-word
// detection in TextLayersOverlay picks the right word every time.
function synthWords(text, x, y, w, h) {
  if (!text) return [];
  const charW = w / Math.max(1, text.length);
  const out = [];
  // Split on whitespace runs, keep separators so cursor stays in sync.
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
  const threshold = medianH * 0.7;

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
function renderEdits(ctx, p) {
  const src = p.canvas;
  const PAD = 1;
  for (const l of p.layers) {
    const needsErase = l.deleted || l.edited || (l.moved && !l.deleted);
    if (!needsErase) continue;
    ctx.fillStyle = l.bgColor || '#ffffff';
    ctx.fillRect(
      (l.originalX ?? l.x) - PAD,
      (l.originalY ?? l.y) - PAD,
      (l.originalW ?? l.w) + PAD * 2,
      (l.originalH ?? l.h) + PAD * 2,
    );
  }
  for (const l of p.layers) {
    if (l.deleted || l.edited || l.visible === false) continue;
    if (!l.moved) continue;
    // Lift the original glyph pixels and place them at the new position.
    // Same source/dest dimensions = no scaling = no metric drift.
    const sx = l.originalX ?? l.x;
    const sy = l.originalY ?? l.y;
    const sw = l.originalW ?? l.w;
    const sh = l.originalH ?? l.h;
    ctx.drawImage(src, sx, sy, sw, sh, l.x, l.y, sw, sh);
  }
  for (const l of p.layers) {
    if (l.deleted || !l.edited || l.visible === false) continue;
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
  // CURRENT bbox (with a few px of margin). This keeps an edited cell from
  // spilling into adjacent cells — which is what made the table visually
  // collapse in the screenshots. Layer bbox auto-grows as the user types
  // (update() recomputes w from measureText), so the clip grows with it.
  {
    const PADC = 2;
    const cox = l.originalX ?? l.x, coy = l.originalY ?? l.y;
    const cow = l.originalW ?? l.w, coh = l.originalH ?? l.h;
    const cx = Math.min(cox, l.x) - PADC;
    const cy = Math.min(coy, l.y) - PADC;
    const cw = Math.max(cox + cow, l.x + l.w) - cx + PADC;
    const ch = Math.max(coy + coh, l.y + l.h) - cy + PADC;
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
  const baseY = l.ascent ? (l.y + l.ascent) : (l.y + l.h);
  // Resolve text-align — shift the draw-X so center/right text sits inside
  // the layer rect without changing the bbox itself.
  const align = l.textAlign || 'left';
  let drawX = l.x;
  if (align === 'center') drawX = l.x + Math.max(0, (l.w - newW) / 2);
  else if (align === 'right') drawX = l.x + Math.max(0, l.w - newW);
  const newTop = baseY - ascent;
  const newBottom = baseY + descent;
  const PAD = 1;
  const bg = l.bgColor || '#ffffff';
  ctx.fillStyle = bg;
  const ox = l.originalX ?? l.x, oy = l.originalY ?? l.y;
  const ow = l.originalW ?? l.w, oh = l.originalH ?? l.h;
  ctx.fillRect(ox - PAD, oy - PAD, ow + PAD * 2, oh + PAD * 2);
  const newLeft = l.x - PAD;
  const newRight = l.x + Math.max(l.w, Math.ceil(newW)) + PAD;
  const newTopP = Math.min(l.y, newTop) - PAD;
  const newBottomP = Math.max(l.y + l.h, newBottom) + PAD;
  if (newLeft < ox - PAD || newRight > ox + ow + PAD || newTopP < oy - PAD || newBottomP > oy + oh + PAD) {
    ctx.fillRect(newLeft, newTopP, newRight - newLeft, newBottomP - newTopP);
  }
  const fg = l.colorEdited ? (l.color || '#111111') : ensureContrast(l.color || '#111111', bg);
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
  if (Math.abs(la - lb) < 40) return lb > 128 ? '#111111' : '#ffffff';
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
