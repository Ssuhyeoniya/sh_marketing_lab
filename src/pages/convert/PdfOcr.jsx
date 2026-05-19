import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { renderPageToCanvas, loadPdfJs, downloadBlob } from '../../utils/pdf';
import { recognizeImage } from '../../utils/ocr';

export default function PdfOcr() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [text, setText] = useState('');

  const run = async () => {
    setBusy(true);
    setText('');
    try {
      const pdf = await loadPdfJs(file);
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const canvas = await renderPageToCanvas(pdf, i, 2);
        const data = await recognizeImage(canvas, (p) => {
          if (p && p.progress != null) {
            const pageBase = ((i - 1) / pdf.numPages) * 100;
            setProgress(Math.round(pageBase + (p.progress * 100) / pdf.numPages));
          }
        });
        out.push(`— Page ${i} —\n${data.text}`);
      }
      setText(out.join('\n\n'));
      setProgress(100);
    } finally {
      setBusy(false);
    }
  };

  const downloadTxt = () => {
    downloadBlob(text, file.name.replace(/\.pdf$/i, '') + '.txt', 'text/plain');
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>PDF 업로드</h3>
          <DropZone accept="application/pdf" onFiles={(fs) => setFile(fs[0])} />
          {file && <div style={{ marginTop: 12, padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12 }}>{file.name}</div>}
          {busy && (
            <div style={{ marginTop: 12 }}>
              <div className="progress"><div style={{ width: `${progress}%` }} /></div>
              <small style={{ color: 'var(--text-muted)' }}>OCR 진행 중 {progress}%</small>
            </div>
          )}
          {text && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <b style={{ fontSize: 13 }}>인식 결과</b>
                <button className="btn sm primary" onClick={downloadTxt}>TXT 다운로드</button>
              </div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', height: 300, fontFamily: 'monospace', fontSize: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }} />
            </div>
          )}
        </div>
        <div className="panel">
          <h3>옵션</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            스캔된 PDF 또는 이미지 기반 PDF에서 한국어/영어 텍스트를 추출합니다. Tesseract.js 사용 · 첫 실행 시 약 8MB 모델을 받습니다.
          </p>
          <button className="btn primary" disabled={!file || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? `진행 ${progress}%` : 'OCR 시작'}
          </button>
        </div>
      </div>
    </div>
  );
}
