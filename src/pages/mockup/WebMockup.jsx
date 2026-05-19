import { useEffect, useRef, useState } from 'react';
import DropZone from '../../components/DropZone';
import { loadImage, fileToDataURL, canvasToBlob } from '../../utils/image';
import { downloadBlob } from '../../utils/pdf';

const PRESETS = [
  { label: 'Mac · Safari', frameW: 1440, frameH: 900, top: 64, side: 18, bottom: 18, dotColor: '#ddd' },
  { label: 'Mac · Chrome', frameW: 1440, frameH: 900, top: 80, side: 18, bottom: 18, dotColor: '#aaa' },
  { label: 'Browser · Generic', frameW: 1280, frameH: 800, top: 56, side: 8, bottom: 8, dotColor: '#bbb' },
];

export default function WebMockup() {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [file, setFile] = useState(null);
  const [img, setImg] = useState(null);
  const [url, setUrl] = useState('https://sh-marketing-lab.local');
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!file) return;
    (async () => {
      const u = await fileToDataURL(file);
      const im = await loadImage(u);
      setImg(im);
    })();
  }, [file]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const c = canvasRef.current;
    c.width = preset.frameW;
    c.height = preset.frameH;
    const ctx = c.getContext('2d');
    // Frame body (window chrome)
    ctx.fillStyle = '#e8eaed';
    roundedRect(ctx, 0, 0, c.width, c.height, 12);
    ctx.fill();
    // Top bar
    ctx.fillStyle = '#f7f8fa';
    roundedRect(ctx, 0, 0, c.width, preset.top, 12, 'top');
    ctx.fill();
    // Traffic lights
    ['#ff5f57', '#ffbd2e', '#28c940'].forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(20 + i * 18, 24, 6, 0, Math.PI * 2);
      ctx.fill();
    });
    // URL bar
    ctx.fillStyle = '#fff';
    roundedRect(ctx, c.width / 2 - 200, 16, 400, 28, 14);
    ctx.fill();
    ctx.fillStyle = '#666';
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔒  ' + url, c.width / 2 - 188, 30);
    // Content area
    const cx = preset.side, cy = preset.top, cw = c.width - preset.side * 2, ch = c.height - preset.top - preset.bottom;
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx, cy, cw, ch);
    if (img) {
      // Fit width
      const ratio = cw / img.naturalWidth;
      const w = cw, h = img.naturalHeight * ratio;
      // top-aligned, may overflow → clip
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();
      ctx.drawImage(img, cx, cy, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('이미지를 업로드하면 여기에 표시됩니다', c.width / 2, c.height / 2);
      ctx.textAlign = 'start';
    }
    // Outer border
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    roundedRect(ctx, 0.5, 0.5, c.width - 1, c.height - 1, 12);
    ctx.stroke();
  }, [preset, img, url]);

  const exportPng = async () => {
    const blob = await canvasToBlob(canvasRef.current, 'image/png');
    downloadBlob(blob, 'web-mockup.png', 'image/png');
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>스크린샷 업로드</h3>
          <DropZone accept="image/*" onFiles={(fs) => setFile(fs[0])} hint="브라우저 화면 캡처 권장 · 너비에 맞춰 자동 배치" />
          {file && <div style={{ marginTop: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>{file.name}</div>}
          <div style={{ marginTop: 18 }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', borderRadius: 8 }} />
          </div>
        </div>
        <div className="panel">
          <h3>옵션</h3>
          <div className="form-row">
            <label>프레임</label>
            <select onChange={(e) => setPreset(PRESETS[+e.target.value])} value={PRESETS.indexOf(preset)}>
              {PRESETS.map((p, i) => <option key={i} value={i}>{p.label} · {p.frameW}×{p.frameH}</option>)}
            </select>
          </div>
          <div className="form-row"><label>URL 표시</label><input value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <button className="btn primary" disabled={!file} onClick={exportPng} style={{ width: '100%' }}>PNG 다운로드</button>
        </div>
      </div>
    </div>
  );
}

function roundedRect(ctx, x, y, w, h, r, only = 'all') {
  ctx.beginPath();
  if (only === 'top') {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }
  ctx.closePath();
}
