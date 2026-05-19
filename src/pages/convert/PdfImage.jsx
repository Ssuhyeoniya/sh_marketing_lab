import { useState } from 'react';
import JSZip from 'jszip';
import DropZone from '../../components/DropZone';
import { pdfToImages, imagesToPdf, downloadBlob } from '../../utils/pdf';

export default function PdfImage() {
  const [mode, setMode] = useState('pdf2img'); // 'pdf2img' | 'img2pdf'
  const [files, setFiles] = useState([]);
  const [format, setFormat] = useState('png');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);

  const run = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      if (mode === 'pdf2img') {
        const images = await pdfToImages(files[0], format, scale);
        setResults(images);
      } else {
        const bytes = await imagesToPdf(files);
        downloadBlob(bytes, `images-${Date.now()}.pdf`, 'application/pdf');
      }
    } finally {
      setBusy(false);
    }
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    results.forEach((r, i) => zip.file(r.name, r.blob));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `images-${Date.now()}.zip`, 'application/zip');
  };

  return (
    <div className="content">
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={'btn ' + (mode === 'pdf2img' ? 'primary' : '')} onClick={() => { setMode('pdf2img'); setFiles([]); setResults(null); }}>
          PDF → Image
        </button>
        <button className={'btn ' + (mode === 'img2pdf' ? 'primary' : '')} onClick={() => { setMode('img2pdf'); setFiles([]); setResults(null); }}>
          Image → PDF
        </button>
      </div>

      <div className="content-grid-2">
        <div className="panel">
          <h3>{mode === 'pdf2img' ? 'PDF 업로드' : '이미지 업로드 (다중 선택 = 한 PDF로 결합)'}</h3>
          <DropZone
            accept={mode === 'pdf2img' ? 'application/pdf' : 'image/png,image/jpeg'}
            multiple={mode === 'img2pdf'}
            onFiles={(fs) => setFiles(mode === 'pdf2img' ? [fs[0]] : fs)}
            hint={mode === 'pdf2img' ? '한 번에 한 파일' : 'PNG / JPG · 페이지 순서대로 결합'}
          />
          <div style={{ marginTop: 12 }}>
            {files.map((f, i) => (
              <div key={i} style={{ padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12, marginBottom: 4 }}>
                {f.name}
              </div>
            ))}
          </div>

          {results && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <b style={{ fontSize: 13 }}>변환 결과 ({results.length}개)</b>
                <button className="btn sm primary" onClick={downloadZip}>ZIP 다운로드</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                {results.map((r, i) => (
                  <img key={i} src={URL.createObjectURL(r.blob)} alt="" style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }} onClick={() => downloadBlob(r.blob, r.name)} />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h3>옵션</h3>
          {mode === 'pdf2img' && (
            <>
              <div className="form-row">
                <label>출력 형식</label>
                <select value={format} onChange={(e) => setFormat(e.target.value)}>
                  <option value="png">PNG</option>
                  <option value="jpg">JPG</option>
                </select>
              </div>
              <div className="form-row">
                <label>해상도 배율 (1~3)</label>
                <input type="number" min="1" max="3" step="0.5" value={scale} onChange={(e) => setScale(+e.target.value)} />
              </div>
            </>
          )}
          {mode === 'img2pdf' && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              여러 이미지를 한 PDF로 결합합니다. 각 이미지가 한 페이지가 됩니다.
            </p>
          )}
          <button className="btn primary" disabled={!files.length || busy} onClick={run} style={{ width: '100%', marginTop: 12 }}>
            {busy ? '변환 중...' : '변환 시작'}
          </button>
        </div>
      </div>
    </div>
  );
}
