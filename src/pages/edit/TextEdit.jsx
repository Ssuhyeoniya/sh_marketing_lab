import { useEffect, useRef, useState } from 'react';
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
  const [src, setSrc] = useState(null); // canvas of source
  const [srcName, setSrcName] = useState('');
  const [layers, setLayers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const previewRef = useRef(null);

  const onFiles = async (fs) => {
    const f = fs[0];
    if (!f) return;
    setSrcName(f.name);
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      const pdf = await loadPdfJs(f);
      const c = await renderPageToCanvas(pdf, 1, 2);
      setSrc(c);
    } else {
      const url = await fileToDataURL(f);
      const im = await loadImage(url);
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      setSrc(c);
    }
    setLayers([]);
  };

  const runOcr = async () => {
    if (!src) return;
    setBusy(true); setProgress(0);
    const data = await recognizeImage(src, (p) => {
      if (p && p.progress != null) setProgress(Math.round(p.progress * 100));
    });
    const next = (data.words || [])
      .filter((w) => w.text && w.text.trim() && w.confidence > 30)
      .map((w) => {
        const g = guessFont(w, src);
        return {
          id: crypto.randomUUID(),
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          fontFamily: g.font.family,
          fontName: g.font.name,
          fontSize: g.size,
          fontWeight: g.weight,
          color: sampleFg(src, w.bbox),
          bgColor: sampleBg(src, w.bbox),
          visible: true,
        };
      });
    setLayers(next);
    setBusy(false);
  };

  useEffect(() => {
    if (!src || !previewRef.current) return;
    const c = previewRef.current;
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    layers.filter((l) => l.visible).forEach((l) => {
      ctx.fillStyle = l.bgColor || '#ffffff';
      ctx.fillRect(l.x - 1, l.y - 1, l.w + 2, l.h + 2);
      ctx.fillStyle = l.color || '#111111';
      ctx.font = `${l.fontWeight || 400} ${l.fontSize || 14}px ${l.fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.fillText(l.text, l.x, l.y);
    });
  }, [src, layers]);

  const exportPng = async () => {
    const blob = await canvasToBlob(previewRef.current, 'image/png');
    downloadBlob(blob, (srcName.replace(/\.[^.]+$/, '') || 'edited') + '-edited.png', 'image/png');
  };

  const update = (id, patch) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const del = (id) => setLayers((ls) => ls.filter((l) => l.id !== id));

  return (
    <div className="content content-grid-3" style={{ height: 'calc(100vh - 60px)' }}>
      <div className="panel">
        <h3>이미지 또는 PDF 업로드</h3>
        {!src ? (
          <DropZone accept="image/*,application/pdf" onFiles={onFiles} hint="이미지 · 또는 PDF (첫 페이지)" />
        ) : (
          <>
            <div style={{ fontSize: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, marginBottom: 12 }}>{srcName}</div>
            <button className="btn" onClick={() => { setSrc(null); setLayers([]); setSrcName(''); }} style={{ width: '100%', marginBottom: 8 }}>다른 파일</button>
            <button className="btn primary" disabled={busy} onClick={runOcr} style={{ width: '100%' }}>
              {busy ? `OCR ${progress}%` : 'OCR 텍스트 인식'}
            </button>
            {busy && progress > 0 && <div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${progress}%` }} /></div>}
            <p style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-muted)' }}>
              인식된 단어들은 위치·폰트·사이즈가 자동으로 추정되어 같은 자리에서 편집 가능합니다.
            </p>
          </>
        )}
      </div>

      <div className="canvas-panel">
        <div className="canvas-toolbar">
          <div style={{ fontSize: 13, fontWeight: 600 }}>미리보기 · 편집 결과</div>
          <button className="btn primary sm" disabled={!src} onClick={exportPng}>PNG 다운로드</button>
        </div>
        <div className="canvas-area">
          {src ? (
            <canvas ref={previewRef} style={{ maxWidth: '100%', maxHeight: '100%', border: '1px solid var(--border)', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }} />
          ) : (
            <div className="empty-hero"><div className="big">✎</div><h2>텍스트 편집</h2><p>이미지 또는 PDF를 업로드해 텍스트를 인식하고 동일 폰트로 수정하세요.</p></div>
          )}
        </div>
      </div>

      <div className="panel">
        <h3>인식된 텍스트 ({layers.length})</h3>
        {layers.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>OCR을 실행해 텍스트를 추출하세요.</p>}
        {layers.map((l) => (
          <div key={l.id} className="text-layer-card">
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
              <button className="btn sm" onClick={() => update(l.id, { visible: !l.visible })}>{l.visible ? '숨김' : '표시'}</button>
              <button className="btn sm danger" onClick={() => del(l.id)}>삭제</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function sampleBg(canvas, bbox) {
  const ctx = canvas.getContext('2d');
  try {
    const p = ctx.getImageData(Math.max(0, Math.floor((bbox.x0 + bbox.x1) / 2)), Math.max(0, bbox.y0 - 4), 1, 1).data;
    return `rgb(${p[0]},${p[1]},${p[2]})`;
  } catch { return '#ffffff'; }
}
function sampleFg(canvas, bbox) {
  const ctx = canvas.getContext('2d');
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  if (w < 2 || h < 2) return '#111';
  try {
    const data = ctx.getImageData(bbox.x0, bbox.y0, w, h).data;
    let r=0,g=0,b=0,n=0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
      if (lum < 128) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
    }
    if (!n) return '#111';
    return `rgb(${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)})`;
  } catch { return '#111'; }
}
function rgbToHex(s) {
  if (!s) return '#000000';
  if (s.startsWith('#')) return s;
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
}
