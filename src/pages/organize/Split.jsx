import { useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { splitPdf, downloadBlob } from '../../utils/pdf';

export default function Split() {
  const [file, setFile] = useState(null);
  const [perChunk, setPerChunk] = useState(1);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const chunks = await splitPdf(file, +perChunk);
      const zip = new JSZip();
      chunks.forEach((c) => {
        const range = c.range[0] === c.range[1] ? `p${c.range[0]}` : `p${c.range[0]}-${c.range[1]}`;
        zip.file(`split-${range}.pdf`, c.bytes);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, file.name.replace(/\.pdf$/i, '') + '-split.zip', 'application/zip');
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
            <label>한 파일당 페이지 수</label>
            <input type="number" min="1" value={perChunk} onChange={(e) => setPerChunk(+e.target.value)} />
          </div>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '분할 중...' : '분할 후 ZIP 다운로드'}
          </button>
        </div>
      </div>
    </div>
  );
}
