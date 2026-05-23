import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export async function loadPdfDoc(file) {
  const buf = await file.arrayBuffer();
  return await PDFDocument.load(buf, { ignoreEncryption: true });
}

export async function loadPdfJs(file) {
  const buf = await file.arrayBuffer();
  return await pdfjsLib.getDocument({ data: buf }).promise;
}

export async function renderPageToCanvas(pdf, pageNum, scale = 1.5) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// 2D affine transform compose using PDF/pdfjs convention [a,b,c,d,e,f]
// representing the 3x3 matrix [a b 0; c d 0; e f 1] for row vectors.
// Equivalent to pdfjs's removed `Util.transform(m1, m2)` (= m1·m2).
function composeAffine(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// Extract the native PDF text layer for a page at the same rasterization scale
// as renderPageToCanvas, so item coordinates match the canvas pixel grid.
// Returns { items, styles } where styles is pdfjs's font metadata map keyed by
// item.fontName. Each item: { text, fontName, fontSize, angleDeg, x, y, baseY,
// w, h, ascent, descent }. Coordinates are in canvas pixels.
export async function extractPageTextItems(pdf, pageNum, canvasScale = 2) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: canvasScale });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it || it.type) continue; // marked-content boundaries
    if (!it.str || !it.str.trim()) continue;
    if (!it.transform || it.transform.length < 6) continue;
    const tx = composeAffine(viewport.transform, it.transform);
    const baseX = tx[4];
    const baseY = tx[5];
    const angleDeg = (Math.atan2(tx[1], tx[0]) * 180) / Math.PI;
    // pdfjs reports two height-related quantities:
    //   1. Math.hypot(tx[2], tx[3])   — derived from the text matrix, which
    //      can be inflated by font-size scaling tricks (e.g. Tf 1pt + Tm 12x).
    //   2. it.height * canvasScale    — the on-screen height of the visible
    //      glyph box. This is what the user actually sees rendered.
    // Use (2) as the canonical font size when available so the inline editor
    // and the canvas redraw match the original glyph footprint exactly. Fall
    // back to (1) only when pdfjs didn't supply a sensible height.
    const transformHeight = Math.hypot(tx[2], tx[3]);
    const itemHeight = Math.abs(it.height || 0) * canvasScale;
    const fontSize = itemHeight > 2 ? itemHeight : transformHeight;
    if (!isFinite(fontSize) || fontSize < 1) continue;
    const wCanvas = (it.width || 0) * canvasScale;
    const ascent = fontSize * 0.84;
    const descent = fontSize * 0.16;
    items.push({
      text: it.str,
      fontName: it.fontName || '',
      fontSize,
      angleDeg,
      x: baseX,
      y: baseY - ascent,
      baseY,
      w: Math.max(wCanvas, fontSize * 0.5),
      h: fontSize, // exactly match fontSize so the editor box and the glyphs align
      ascent,
      descent,
      hasEOL: !!it.hasEOL,
    });
  }
  return { items, styles: tc.styles || {} };
}

export async function pdfToImages(file, format = 'png', scale = 2) {
  const pdf = await loadPdfJs(file);
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const canvas = await renderPageToCanvas(pdf, i, scale);
    const blob = await new Promise((res) =>
      canvas.toBlob(res, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92)
    );
    images.push({ blob, name: `page-${i}.${format}` });
  }
  return images;
}

export async function imagesToPdf(files) {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const bytes = await f.arrayBuffer();
    const isPng = f.type === 'image/png' || f.name.toLowerCase().endsWith('.png');
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  return await doc.save();
}

export async function mergePdfs(files) {
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await loadPdfDoc(f);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return await out.save();
}

export async function rotatePdf(file, angle) {
  const src = await loadPdfDoc(file);
  src.getPages().forEach((p) => p.setRotation(degrees(angle)));
  return await src.save();
}

export async function deletePagesFromPdf(file, pages0) {
  const src = await loadPdfDoc(file);
  const set = new Set(pages0);
  const out = await PDFDocument.create();
  const keep = src.getPageIndices().filter((i) => !set.has(i));
  const copied = await out.copyPages(src, keep);
  copied.forEach((p) => out.addPage(p));
  return await out.save();
}

export async function extractPagesFromPdf(file, pages0) {
  const src = await loadPdfDoc(file);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pages0);
  copied.forEach((p) => out.addPage(p));
  return await out.save();
}

export async function splitPdf(file, perChunk = 1) {
  const src = await loadPdfDoc(file);
  const total = src.getPageCount();
  const chunks = [];
  for (let i = 0; i < total; i += perChunk) {
    const out = await PDFDocument.create();
    const indices = [];
    for (let j = i; j < Math.min(i + perChunk, total); j++) indices.push(j);
    const copied = await out.copyPages(src, indices);
    copied.forEach((p) => out.addPage(p));
    chunks.push({ bytes: await out.save(), range: [i + 1, Math.min(i + perChunk, total)] });
  }
  return chunks;
}

export async function addWatermark(file, text, opts = {}) {
  const src = await loadPdfDoc(file);
  const font = await src.embedFont(StandardFonts.HelveticaBold);
  const size = opts.size ?? 48;
  const color = opts.color ?? rgb(0.7, 0.7, 0.7);
  const opacity = opts.opacity ?? 0.3;
  const angle = opts.angle ?? 45;
  src.getPages().forEach((p) => {
    const { width, height } = p.getSize();
    p.drawText(text, {
      x: width / 4,
      y: height / 2,
      size,
      font,
      color,
      opacity,
      rotate: degrees(angle),
    });
  });
  return await src.save();
}

export async function addPageNumbers(file, opts = {}) {
  const src = await loadPdfDoc(file);
  const font = await src.embedFont(StandardFonts.Helvetica);
  const size = opts.size ?? 11;
  const pos = opts.position ?? 'bottom-center';
  const pages = src.getPages();
  pages.forEach((p, idx) => {
    const { width, height } = p.getSize();
    const txt = `${idx + 1} / ${pages.length}`;
    const tw = font.widthOfTextAtSize(txt, size);
    let x = width / 2 - tw / 2, y = 20;
    if (pos.endsWith('right')) x = width - tw - 24;
    if (pos.endsWith('left')) x = 24;
    if (pos.startsWith('top')) y = height - 24;
    p.drawText(txt, { x, y, size, font, color: rgb(0.3, 0.3, 0.3) });
  });
  return await src.save();
}

export function downloadBlob(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
