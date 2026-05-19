import { useState } from 'react';
import DropZone from '../../components/DropZone';
import PageSelector from './_PageSelector';
import { deletePagesFromPdf, downloadBlob } from '../../utils/pdf';

export default function DeletePages() {
  const [file, setFile] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await deletePagesFromPdf(file, [...sel]);
      downloadBlob(bytes, file.name.replace(/\.pdf$/i, '') + '-deleted.pdf', 'application/pdf');
    } finally { setBusy(false); }
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>PDF 업로드 + 삭제할 페이지 선택</h3>
          <DropZone accept="application/pdf" onFiles={(fs) => { setFile(fs[0]); setSel(new Set()); }} />
          {file && <div style={{ margin: '12px 0', padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>{file.name}</div>}
          <PageSelector file={file} onChange={setSel} />
        </div>
        <div className="panel">
          <h3>실행</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            선택한 페이지가 삭제된 PDF가 새로 만들어집니다. 원본은 유지됩니다.
          </p>
          <button className="btn primary" disabled={!file || sel.size === 0 || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '처리 중...' : `${sel.size}개 페이지 삭제`}
          </button>
        </div>
      </div>
    </div>
  );
}
