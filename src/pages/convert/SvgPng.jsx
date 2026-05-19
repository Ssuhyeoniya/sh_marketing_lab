import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { downloadBlob } from '../../utils/pdf';
import { loadImage, canvasToBlob } from '../../utils/image';

export default function SvgPng() {
  const [mode, setMode] = useState('svg2png'); // 'svg2png' | 'png2svg'
  const [file, setFile] = useState(null);
  const [scale, setScale] = useState(2);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  const onFiles = async (fs) => {
    const f = fs[0];
    if (!f) return;
    setFile(f);
    setPreview(null);
    // Detect natural size for previews
    if (mode === 'svg2png') {
      const text = await f.text();
      const m1 = text.match(/width="([\d.]+)"/);
      const m2 = text.match(/height="([\d.]+)"/);
      const vb = text.match(/viewBox="[\d.\s]*?\s([\d.]+)\s([\d.]+)"/);
      const w = m1 ? +m1[1] : vb ? +vb[1] : 512;
      const h = m2 ? +m2[1] : vb ? +vb[2] : 512;
      setWidth(Math.round(w));
      setHeight(Math.round(h));
    } else {
      const url = URL.createObjectURL(f);
      const im = await loadImage(url);
      URL.revokeObjectURL(url);
      setWidth(im.naturalWidth);
      setHeight(im.naturalHeight);
    }
  };

  const runSvg2Png = async () => {
    setBusy(true);
    try {
      const text = await file.text();
      const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const outW = Math.round((width || img.naturalWidth) * scale);
      const outH = Math.round((height || img.naturalHeight) * scale);
      const c = document.createElement('canvas');
      c.width = outW;
      c.height = outH;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, outW, outH);
      const out = await canvasToBlob(c, 'image/png');
      setPreview(URL.createObjectURL(out));
      downloadBlob(out, (file.name.replace(/\.svg$/i, '') || 'image') + '.png', 'image/png');
    } finally {
      setBusy(false);
    }
  };

  const runPng2Svg = async () => {
    // PNG→SVG vectorization is non-trivial; we embed the PNG inside an SVG wrapper.
    // This produces a valid SVG that displays the bitmap (works in any browser/Figma/etc.).
    setBusy(true);
    try {
      const dataUrl = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(file);
      });
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <image width="${width}" height="${height}" xlink:href="${dataUrl}"/>
</svg>`;
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      setPreview(URL.createObjectURL(blob));
      downloadBlob(blob, (file.name.replace(/\.[^.]+$/, '') || 'image') + '.svg', 'image/svg+xml');
    } finally {
      setBusy(false);
    }
  };

  const run = mode === 'svg2png' ? runSvg2Png : runPng2Svg;

  return (
    <div className="content">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={'btn ' + (mode === 'svg2png' ? 'primary' : '')} onClick={() => { setMode('svg2png'); setFile(null); setPreview(null); }}>SVG → PNG</button>
        <button className={'btn ' + (mode === 'png2svg' ? 'primary' : '')} onClick={() => { setMode('png2svg'); setFile(null); setPreview(null); }}>PNG → SVG</button>
      </div>

      <div className="content-grid-2">
        <div className="panel">
          <h3>{mode === 'svg2png' ? 'SVG 업로드' : 'PNG/이미지 업로드'}</h3>
          <DropZone
            accept={mode === 'svg2png' ? 'image/svg+xml,.svg' : 'image/png,image/jpeg'}
            onFiles={onFiles}
            hint={mode === 'svg2png' ? '벡터 → 비트맵 변환' : '비트맵을 SVG 컨테이너에 임베드'}
          />
          {file && (
            <div style={{ marginTop: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>
              {file.name} · 원본 {width}×{height}
            </div>
          )}
          {preview && (
            <div style={{ marginTop: 16 }}>
              <b style={{ fontSize: 12, color: 'var(--text-muted)' }}>미리보기</b>
              <div style={{ marginTop: 6, padding: 12, background: '#fafbfc', border: '1px solid var(--border)', borderRadius: 6, textAlign: 'center' }}>
                <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: 300 }} />
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h3>옵션</h3>
          {mode === 'svg2png' ? (
            <>
              <div className="form-row"><label>출력 너비 (px)</label><input type="number" value={width} onChange={(e) => setWidth(+e.target.value)} /></div>
              <div className="form-row"><label>출력 높이 (px)</label><input type="number" value={height} onChange={(e) => setHeight(+e.target.value)} /></div>
              <div className="form-row"><label>해상도 배율 (1~4)</label><input type="number" min="1" max="4" step="0.5" value={scale} onChange={(e) => setScale(+e.target.value)} /></div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>SVG를 너비×높이×배율 크기 PNG로 렌더링합니다. (예: 512×512 × 2배 = 1024×1024)</p>
            </>
          ) : (
            <>
              <div className="form-row"><label>SVG 너비</label><input type="number" value={width} onChange={(e) => setWidth(+e.target.value)} /></div>
              <div className="form-row"><label>SVG 높이</label><input type="number" value={height} onChange={(e) => setHeight(+e.target.value)} /></div>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
                PNG는 비트맵, SVG는 벡터입니다. 진정한 자동 벡터화는 어려워, 비트맵을 SVG 컨테이너로 감싼 형태로 변환합니다.
                Figma/브라우저/PowerPoint 등에서 SVG로 사용 가능합니다.
              </p>
            </>
          )}
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '변환 중...' : '변환 및 다운로드'}
          </button>
        </div>
      </div>
    </div>
  );
}
