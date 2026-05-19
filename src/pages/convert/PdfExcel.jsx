import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { downloadBlob } from '../../utils/pdf';
import { extractTextByPage, pagesToCsv } from './_helpers';

export default function PdfExcel() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const pages = await extractTextByPage(file);
      const csv = pagesToCsv(pages);
      // BOM for Excel Korean
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, file.name.replace(/\.pdf$/i, '') + '.csv', 'text/csv');
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
            PDF의 텍스트를 줄 단위로 추출해 CSV로 저장합니다. Excel에서 바로 열 수 있습니다.
            실제 표 구조는 자동으로 복원되지 않으므로 단순 데이터 추출용으로 적합합니다.
          </p>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '변환 중...' : 'CSV(Excel)로 변환'}
          </button>
        </div>
      </div>
    </div>
  );
}
