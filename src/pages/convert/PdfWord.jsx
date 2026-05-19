import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { downloadBlob } from '../../utils/pdf';
import { extractTextByPage, pagesToDocHtml } from './_helpers';

export default function PdfWord() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const pages = await extractTextByPage(file);
      const doc = pagesToDocHtml(pages);
      downloadBlob(doc, file.name.replace(/\.pdf$/i, '') + '.doc', 'application/msword');
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
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            PDF의 텍스트를 추출해 Word(.doc)로 저장합니다. 레이아웃·표·이미지는 보존되지 않으며 텍스트 위주로 변환됩니다.
          </p>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '변환 중...' : 'Word로 변환'}
          </button>
        </div>
      </div>
    </div>
  );
}
