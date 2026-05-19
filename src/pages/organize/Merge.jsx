import { useState } from 'react';
import DropZone from '../../components/DropZone';
import { mergePdfs, downloadBlob } from '../../utils/pdf';

export default function Merge() {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= files.length) return;
    const next = [...files];
    [next[i], next[j]] = [next[j], next[i]];
    setFiles(next);
  };

  const run = async () => {
    setBusy(true);
    try {
      const bytes = await mergePdfs(files);
      downloadBlob(bytes, `merged-${Date.now()}.pdf`, 'application/pdf');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="content-grid-2">
        <div className="panel">
          <h3>PDF 파일 추가 (순서대로 결합)</h3>
          <DropZone
            accept="application/pdf"
            multiple
            onFiles={(fs) => setFiles([...files, ...fs])}
            hint="여러 PDF를 선택해 한 파일로 결합합니다"
          />
          <div style={{ marginTop: 12 }}>
            {files.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: '#f7f8fa', borderRadius: 6, fontSize: 12, marginBottom: 6 }}>
                <span style={{ flex: 1 }}>{i + 1}. {f.name}</span>
                <button className="btn sm" onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" onClick={() => move(i, 1)}>↓</button>
                <button className="btn sm danger" onClick={() => setFiles(files.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>실행</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            위에 표시된 순서대로 PDF가 결합됩니다. 화살표로 순서를 조정하세요.
          </p>
          <button className="btn primary" disabled={files.length < 2 || busy} onClick={run} style={{ width: '100%' }}>
            {busy ? '결합 중...' : `${files.length}개 PDF 결합`}
          </button>
        </div>
      </div>
    </div>
  );
}
