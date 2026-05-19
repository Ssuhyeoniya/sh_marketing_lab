import { useEffect, useRef, useState } from 'react';
import DropZone from '../../components/DropZone';
import { downloadBlob } from '../../utils/pdf';
import { loadImage, fileToDataURL, cropCanvas, canvasToBlob } from '../../utils/image';

export default function Crop() {
  const [file, setFile] = useState(null);
  const [img, setImg] = useState(null);
  const [rect, setRect] = useState(null); // {x, y, w, h} in image coords
  const [dragging, setDragging] = useState(null); // {sx, sy}
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!file) return;
    (async () => {
      const url = await fileToDataURL(file);
      const im = await loadImage(url);
      setImg(im);
      setRect({ x: im.naturalWidth * 0.15, y: im.naturalHeight * 0.15, w: im.naturalWidth * 0.7, h: im.naturalHeight * 0.7 });
    })();
  }, [file]);

  useEffect(() => {
    if (!img || !canvasRef.current) return;
    const c = canvasRef.current;
    const maxW = 800;
    const scale = Math.min(1, maxW / img.naturalWidth);
    c.width = img.naturalWidth * scale;
    c.height = img.naturalHeight * scale;
    c.dataset.scale = scale;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (rect) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, c.width, c.height);
      const rx = rect.x * scale, ry = rect.y * scale, rw = rect.w * scale, rh = rect.h * scale;
      ctx.clearRect(rx, ry, rw, rh);
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, rx, ry, rw, rh);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }, [img, rect]);

  const onMouseDown = (e) => {
    const c = canvasRef.current;
    const scale = +c.dataset.scale;
    const r = c.getBoundingClientRect();
    setDragging({ sx: (e.clientX - r.left) / scale, sy: (e.clientY - r.top) / scale });
  };
  const onMouseMove = (e) => {
    if (!dragging || !img) return;
    const c = canvasRef.current;
    const scale = +c.dataset.scale;
    const r = c.getBoundingClientRect();
    const x2 = (e.clientX - r.left) / scale;
    const y2 = (e.clientY - r.top) / scale;
    const x = Math.max(0, Math.min(dragging.sx, x2));
    const y = Math.max(0, Math.min(dragging.sy, y2));
    const w = Math.min(img.naturalWidth - x, Math.abs(x2 - dragging.sx));
    const h = Math.min(img.naturalHeight - y, Math.abs(y2 - dragging.sy));
    if (w > 4 && h > 4) setRect({ x, y, w, h });
  };
  const onMouseUp = () => setDragging(null);

  const exportCrop = async () => {
    const full = document.createElement('canvas');
    full.width = img.naturalWidth;
    full.height = img.naturalHeight;
    full.getContext('2d').drawImage(img, 0, 0);
    const out = cropCanvas(full, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h));
    const blob = await canvasToBlob(out, 'image/png');
    downloadBlob(blob, (file.name.replace(/\.[^.]+$/, '') || 'crop') + '-crop.png', 'image/png');
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>이미지 업로드 + 영역 드래그</h3>
          {!file && <DropZone accept="image/*" onFiles={(fs) => setFile(fs[0])} />}
          {file && (
            <div>
              <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-muted)' }}>{file.name} · 드래그해서 자를 영역 지정</div>
              <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                style={{ maxWidth: '100%', cursor: 'crosshair', border: '1px solid var(--border)', borderRadius: 6 }}
              />
            </div>
          )}
        </div>
        <div className="panel">
          <h3>옵션</h3>
          {rect && (
            <div style={{ fontSize: 12, marginBottom: 12, padding: 10, background: '#f8f9fb', borderRadius: 6 }}>
              <div>X: {Math.round(rect.x)}</div>
              <div>Y: {Math.round(rect.y)}</div>
              <div>W: {Math.round(rect.w)}</div>
              <div>H: {Math.round(rect.h)}</div>
            </div>
          )}
          <button className="btn primary" disabled={!file || !rect} onClick={exportCrop} style={{ width: '100%' }}>
            잘라낸 영역 다운로드
          </button>
          {file && <button className="btn" onClick={() => { setFile(null); setImg(null); setRect(null); }} style={{ width: '100%', marginTop: 8 }}>다른 이미지</button>}
        </div>
      </div>
    </div>
  );
}
