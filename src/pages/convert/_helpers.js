import { loadPdfJs } from '../../utils/pdf';

export async function extractTextByPage(file) {
  const pdf = await loadPdfJs(file);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str).join(' ');
    const lines = tc.items.reduce((acc, it) => {
      const lastY = acc.length ? acc[acc.length - 1].y : null;
      const y = Math.round(it.transform[5]);
      if (lastY != null && Math.abs(lastY - y) < 3) {
        acc[acc.length - 1].text += it.str;
      } else {
        acc.push({ y, text: it.str });
      }
      return acc;
    }, []);
    pages.push({ pageNum: i, text, lines: lines.map((l) => l.text) });
  }
  return pages;
}

// Minimal Word-readable HTML wrapped as .doc (works with MS Word / Google Docs).
export function pagesToDocHtml(pages) {
  const body = pages
    .map(
      (p) =>
        `<p style="font-weight:bold;">— Page ${p.pageNum} —</p>` +
        p.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')
    )
    .join('<br/>');
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>Document</title></head>
<body>${body}</body></html>`;
}

export function pagesToCsv(pages) {
  const rows = [];
  rows.push(['Page', 'Line', 'Text']);
  pages.forEach((p) =>
    p.lines.forEach((l, i) => rows.push([p.pageNum, i + 1, l]))
  );
  return rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
