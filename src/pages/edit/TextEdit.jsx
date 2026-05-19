import { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { loadImage, fileToDataURL, canvasToBlob } from '../../utils/image';
import { recognizeImage, guessFont } from '../../utils/ocr';
import { loadPdfJs, renderPageToCanvas, downloadBlob } from '../../utils/pdf';

const FONT_OPTIONS = [
  { name: 'SF Pro', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 400 },
  { name: 'SF Pro Bold', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 700 },
  { name: 'Pretendard', family: 'Pretendard, sans-serif', weight: 500 },
  { name: 'Pretendard Bold', family: 'Pretendard, sans-serif', weight: 700 },
  { name: 'Noto Sans KR', family: '"Noto Sans KR", sans-serif', weight: 400 },
  { name: 'Noto Sans KR Bold', family: '"Noto Sans KR", sans-serif', weight: 700 },
  { name: 'Helvetica', family: 'Helvetica, Arial, sans-serif', weight: 400 },
  { name: 'Helvetica Bold', family: 'Helvetica, Arial, sans-serif', weight: 700 },
  { name: 'Times New Roman', family: '"Times New Roman", serif', weight: 400 },
  { name: 'Courier New', family: '"Courier New", monospace', weight: 400 },
];

export default function TextEdit() {
  // pages: [{ id, name, canvas, layers, ocrDone }]
  const [pages, setPages] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [srcName, setSrcName] = useState('');
  const previewRef = useRef(null);

  const current = pages[currentIdx];

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
          out.push({
            id: crypto.randomUUID(),
            name: `${f.name} · p${i}`,
            pageNum: i,
            canvas: c,
            layers: [],
            ocrDone: false,
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
        setPages([{ id: crypto.randomUUID(), name: f.name, pageNum: 1, canvas: c, layers: [], ocrDone: false }]);
        setCurrentIdx(0);
      }
    } finally {
      setBusy(false);
    }
  };

  const runOcrForPage = async (pageIdx, onProg) => {
    const page = pages[pageIdx];
    if (!page) return;
    const data = await recognizeImage(page.canvas, onProg);
    const layers = (data.words || [])
      .filter((w) => {
        if (!w.text || !w.text.trim()) return false;
        if (w.confidence < 60) return false;
        const t = w.text.trim();
        if (t.length < 2) return false;
        if (!/[a-zA-Z0-9가-힣]/.test(t)) return false;
        const bw = w.bbox.x1 - w.bbox.x0;
        const bh = w.bbox.y1 - w.bbox.y0;
        if (bw < 6 || bh < 6) return false;
        if (bh > bw * 3 || bw > bh * 25) return false;
        return true;
      })
      .map((w) => {
        const g = guessFont(w, page.canvas);
        return {
          id: crypto.randomUUID(),
          text: w.text,
          originalText: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          fontFamily: g.font.family,
          fontName: g.font.name,
          fontSize: g.size,
          fontWeight: g.weight,
          color: (() => { const bg = sampleBg(page.canvas, w.bbox); return sampleFg(page.canvas, w.bbox, bg); })(),
          bgColor: sampleBg(page.canvas, w.bbox),
          visible: true,
          edited: false,
        };
      });
    setPages((ps) => ps.map((p, i) => (i === pageIdx ? { ...p, layers, ocrDone: true } : p)));
  };

  const runOcrCurrent = async () => {
    if (!current) return;
    setBusy(true);
    setProgress(0);
    try {
      await runOcrForPage(currentIdx, (p) => {
        if (p && p.progress != null) setProgress(Math.round(p.progress * 100));
      });
    } finally {
      setBusy(false);
    }
  };

  const runOcrAll = async () => {
    setBusy(true);
    setProgress(0);
    try {
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].ocrDone) continue;
        await runOcrForPage(i, (p) => {
          if (p && p.progress != null) {
            const base = (i / pages.length) * 100;
            setProgress(Math.round(base + (p.progress * 100) / pages.length));
          }
        });
      }
      setProgress(100);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!current || !previewRef.current) return;
    const c = previewRef.current;
    c.width = current.canvas.width;
    c.height = current.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(current.canvas, 0, 0);
    current.layers.filter((l) => l.visible && l.edited).forEach((l) => drawTextOverlay(ctx, l));
  }, [current, currentIdx, pages]);

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
                if (patch.text !== undefined && patch.text !== l.originalText) next.edited = true;
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

  const exportCurrentPng = async () => {
    if (!previewRef.current) return;
    const blob = await canvasToBlob(previewRef.current, 'image/png');
    downloadBlob(blob, `${stripExt(srcName) || 'edited'}-p${current.pageNum}.png`, 'image/png');
  };

  const exportAllZip = async () => {
    setBusy(true);
    try {
      const zip = new JSZip();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const c = document.createElement('canvas');
        c.width = p.canvas.width;
        c.height = p.canvas.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(p.canvas, 0, 0);
        p.layers.filter((l) => l.visible && l.edited).forEach((l) => drawTextOverlay(ctx, l));
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
    <div className="content content-grid-3" style={{ height: 'calc(100vh - 60px)' }}>
      <div className="panel">
        <h3>이미지 또는 PDF 업로드</h3>
        {pages.length === 0 ? (
          <DropZone accept="image/*,application/pdf" onFiles={onFiles} hint="이미지 단일 · 또는 PDF (전체 페이지)" />
        ) : (
          <>
            <div style={{ fontSize: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, marginBottom: 10 }}>{srcName}</div>
            <button className="btn" onClick={reset} style={{ width: '100%', marginBottom: 6 }}>다른 파일</button>
            <button className="btn primary" disabled={busy} onClick={runOcrCurrent} style={{ width: '100%', marginBottom: 6 }}>
              {busy ? `OCR ${progress}%` : '현재 페이지 OCR'}
            </button>
            {pages.length > 1 && (
              <button className="btn" disabled={busy} onClick={runOcrAll} style={{ width: '100%', marginBottom: 6 }}>
                {busy ? `전체 ${progress}%` : `전체 ${pages.length}페이지 OCR`}
              </button>
            )}
            {busy && progress > 0 && <div className="progress" style={{ margin: '6px 0' }}><div style={{ width: `${progress}%` }} /></div>}

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

      <div className="canvas-panel">
        <div className="canvas-toolbar">
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {current ? `Page ${current.pageNum} / ${pages.length}` : '미리보기'}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" disabled={!current} onClick={exportCurrentPng}>현재 PNG</button>
            {pages.length > 1 && (
              <button className="btn primary sm" disabled={!pages.length || busy} onClick={exportAllZip}>전체 ZIP</button>
            )}
          </div>
        </div>
        <div className="canvas-area">
          {current ? (
            <canvas ref={previewRef} style={{ maxWidth: '100%', maxHeight: '100%', border: '1px solid var(--border)', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }} />
          ) : (
            <div className="empty-hero"><div className="big">✎</div><h2>텍스트 편집</h2><p>이미지 또는 PDF를 업로드해 텍스트를 인식하고 동일 폰트로 수정하세요. PDF는 전체 페이지 자동 처리.</p></div>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>인식된 텍스트 ({current?.layers.length || 0})</h3>
        {!current && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>파일을 업로드하세요.</p>}
        {current && !current.ocrDone && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>OCR을 실행해 텍스트를 추출하세요.</p>}
        {current && current.ocrDone && current.layers.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>이 페이지에서 인식된 텍스트가 없습니다.</p>
        )}
        {current?.layers.map((l) => (
          <div key={l.id} className="text-layer-card" style={l.edited ? { borderColor: 'var(--primary)', background: '#eff6ff' } : {}}>
            <div style={{ fontSize: 10.5, color: l.edited ? 'var(--primary)' : 'var(--text-muted)', marginBottom: 6 }}>
              {l.edited ? '● 편집됨 (오버레이 적용)' : '○ 원본 유지'}
            </div>
            <div className="form-row"><label>텍스트</label><input value={l.text} onChange={(e) => update(l.id, { text: e.target.value })} /></div>
            <div className="form-row inline">
              <div>
                <label>폰트</label>
                <select value={l.fontName} onChange={(e) => {
                  const o = FONT_OPTIONS.find((f) => f.name === e.target.value);
                  if (o) update(l.id, { fontName: o.name, fontFamily: o.family, fontWeight: o.weight });
                }}>
                  {FONT_OPTIONS.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
              </div>
              <div><label>사이즈</label><input type="number" value={l.fontSize} onChange={(e) => update(l.id, { fontSize: +e.target.value })} /></div>
            </div>
            <div className="form-row inline">
              <div><label>색</label><input type="color" value={rgbToHex(l.color)} onChange={(e) => update(l.id, { color: e.target.value })} /></div>
              <div><label>배경</label><input type="color" value={rgbToHex(l.bgColor || '#fff')} onChange={(e) => update(l.id, { bgColor: e.target.value })} /></div>
            </div>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button className="btn sm" onClick={() => toggleEdited(l.id)}>{l.edited ? '원본으로' : '활성화'}</button>
              <button className="btn sm danger" onClick={() => del(l.id)}>삭제</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function stripExt(s) { return (s || '').replace(/\.[^.]+$/, ''); }

function drawTextOverlay(ctx, l) {
  ctx.font = `${l.fontWeight || 400} ${l.fontSize || 14}px ${l.fontFamily}`;
  const m = ctx.measureText(l.text || ' ');
  const ascent = m.actualBoundingBoxAscent || (l.fontSize || 14) * 0.8;
  const descent = m.actualBoundingBoxDescent || (l.fontSize || 14) * 0.25;
  const newW = m.width;
  const baseY = l.y + l.h;
  const newTop = baseY - ascent;
  const newBottom = baseY + descent;
  const clearX = l.x - 2;
  const clearY = Math.min(l.y - 2, newTop - 2);
  const clearW = Math.max(l.w + 4, Math.ceil(newW) + 4);
  const clearH = Math.max(l.h + 4, Math.ceil(newBottom - newTop) + 4);
  ctx.fillStyle = l.bgColor || '#ffffff';
  ctx.fillRect(clearX, clearY, clearW, clearH);
  const fg = ensureContrast(l.color || '#111111', l.bgColor || '#ffffff');
  ctx.fillStyle = fg;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(l.text || '', l.x, baseY);
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
