import { useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { pdfToImages, downloadBlob } from '../../utils/pdf';

export default function PdfPpt() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const images = await pdfToImages(file, 'png', 2);
      const zip = new JSZip();
      images.forEach((img, i) => zip.file(`slide-${String(i + 1).padStart(2, '0')}.png`, img.blob));
      zip.file(
        'README.txt',
        '각 PNG가 한 슬라이드입니다. PowerPoint에서 "삽입 → 사진"으로 가져와 슬라이드로 배치하세요.'
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, file.name.replace(/\.pdf$/i, '') + '-slides.zip', 'application/zip');
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
            각 PDF 페이지를 슬라이드 이미지(PNG)로 만들어 ZIP으로 묶습니다. PowerPoint에서 이미지로 가져와 슬라이드로 사용하세요.
          </p>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '변환 중...' : '슬라이드 PNG ZIP 생성'}
          </button>
        </div>
      </div>
    </div>
  );
}
