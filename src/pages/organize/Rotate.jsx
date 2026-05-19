import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { rotatePdf, downloadBlob } from '../../utils/pdf';

export default function Rotate() {
  const [file, setFile] = useState(null);
  const [angle, setAngle] = useState(90);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await rotatePdf(file, +angle);
      downloadBlob(bytes, file.name.replace(/\.pdf$/i, '') + `-rot${angle}.pdf`, 'application/pdf');
    } finally {
      setBusy(false);
    }
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
          <h3>옵션</h3>
          <div className="form-row">
            <label>회전 각도</label>
            <select value={angle} onChange={(e) => setAngle(+e.target.value)}>
              <option value={90}>오른쪽 90°</option>
              <option value={180}>180°</option>
              <option value={270}>왼쪽 90° (270°)</option>
            </select>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>모든 페이지에 동일하게 적용됩니다.</p>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '처리 중...' : '회전 적용'}
          </button>
        </div>
      </div>
    </div>
  );
}
