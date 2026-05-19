import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { addPageNumbers, downloadBlob } from '../../utils/pdf';

export default function PageNumbers() {
  const [file, setFile] = useState(null);
  const [position, setPosition] = useState('bottom-center');
  const [size, setSize] = useState(11);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await addPageNumbers(file, { position, size: +size });
      downloadBlob(bytes, file.name.replace(/\.pdf$/i, '') + '-numbered.pdf', 'application/pdf');
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
          <h3>옵션</h3>
          <div className="form-row">
            <label>위치</label>
            <select value={position} onChange={(e) => setPosition(e.target.value)}>
              <option value="bottom-center">하단 중앙</option>
              <option value="bottom-left">하단 왼쪽</option>
              <option value="bottom-right">하단 오른쪽</option>
              <option value="top-center">상단 중앙</option>
              <option value="top-left">상단 왼쪽</option>
              <option value="top-right">상단 오른쪽</option>
            </select>
          </div>
          <div className="form-row"><label>글자 크기 (pt)</label><input type="number" value={size} onChange={(e) => setSize(+e.target.value)} /></div>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '적용 중...' : '페이지 번호 추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
