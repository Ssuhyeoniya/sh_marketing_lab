import { useState } from 'react';
import DropZone from '../../components/DropZone';
import PageSelector from './_PageSelector';
import { extractPagesFromPdf, downloadBlob } from '../../utils/pdf';

export default function ExtractPages() {
  const [file, setFile] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const sorted = [...sel].sort((a, b) => a - b);
      const bytes = await extractPagesFromPdf(file, sorted);
      downloadBlob(bytes, file.name.replace(/\.pdf$/i, '') + '-extracted.pdf', 'application/pdf');
    } finally { setBusy(false); }
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>PDF 업로드 + 추출할 페이지 선택</h3>
          <DropZone accept="application/pdf" onFiles={(fs) => { setFile(fs[0]); setSel(new Set()); }} />
          {file && <div style={{ margin: '12px 0', padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>{file.name}</div>}
          <PageSelector file={file} onChange={setSel} />
        </div>
        <div className="panel">
          <h3>실행</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            선택한 페이지들만 모아 새 PDF로 추출합니다.
          </p>
          <button className="btn primary" disabled={!file || sel.size === 0 || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '처리 중...' : `${sel.size}개 페이지 추출`}
          </button>
        </div>
      </div>
    </div>
  );
}
