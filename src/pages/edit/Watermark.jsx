import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { addWatermark, downloadBlob } from '../../utils/pdf';

export default function Watermark() {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('CONFIDENTIAL');
  const [size, setSize] = useState(48);
  const [angle, setAngle] = useState(45);
  const [opacity, setOpacity] = useState(0.3);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await addWatermark(file, text, { size: +size, angle: +angle, opacity: +opacity });
      downloadBlob(bytes, file.name.replace(/\.pdf$/i, '') + '-watermark.pdf', 'application/pdf');
    } finally { setBusy(false); }
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>PDF 업로드</h3>
          <DropZone accept="application/pdf" onFiles={(fs) => setFile(fs[0])} />
          {file && <div style={{ marginTop: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>{file.name}</div>}
        </div>
        <div className="panel">
          <h3>워터마크 설정</h3>
          <div className="form-row"><label>텍스트</label><input value={text} onChange={(e) => setText(e.target.value)} /></div>
          <div className="form-row inline">
            <div><label>크기 (pt)</label><input type="number" value={size} onChange={(e) => setSize(+e.target.value)} /></div>
            <div><label>각도</label><input type="number" value={angle} onChange={(e) => setAngle(+e.target.value)} /></div>
          </div>
          <div className="form-row"><label>투명도 (0~1)</label><input type="number" step="0.1" min="0" max="1" value={opacity} onChange={(e) => setOpacity(+e.target.value)} /></div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>영문/숫자에 최적화. 한글은 깨질 수 있습니다.</p>
          <button className="btn primary" disabled={!file || busy || !text} onClick={run} style={{ width: '100%' }}>
            {busy ? '적용 중...' : '워터마크 적용'}
          </button>
        </div>
      </div>
    </div>
  );
}
