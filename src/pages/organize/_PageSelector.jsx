import { useEffect, useState } from 'react';
import { loadPdfJs, renderPageToCanvas } from '../../utils/pdf';

// Renders thumbnails of all pages, lets user toggle selection.
// onChange(selectedSet) — Set of 0-based indices.
export default function PageSelector({ file, onChange }) {
  const [thumbs, setThumbs] = useState([]);
  const [selected, setSelected] = useState(new Set());

  useEffect(() => {
    let cancelled = false;
    if (!file) { setThumbs([]); return; }
    (async () => {
      const pdf = await loadPdfJs(file);
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const c = await renderPageToCanvas(pdf, i, 0.4);
        if (cancelled) return;
        out.push(c.toDataURL());
        setThumbs([...out]);
      }
    })();
    return () => { cancelled = true; };
  }, [file]);

  const toggle = (i) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSelected(next);
    onChange?.(next);
  };

  if (!file) return null;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <small style={{ color: 'var(--text-muted)' }}>{thumbs.length}페이지 · 클릭으로 선택</small>
        <small><b>{selected.size}</b>개 선택</small>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 6, maxHeight: 400, overflow: 'auto', padding: 4 }}>
        {thumbs.map((src, i) => (
          <div
            key={i}
            onClick={() => toggle(i)}
            style={{
              position: 'relative',
              border: '2px solid ' + (selected.has(i) ? 'var(--primary)' : 'var(--border)'),
              borderRadius: 4,
              cursor: 'pointer',
              background: '#fff',
            }}
          >
            <img src={src} alt="" style={{ width: '100%', display: 'block' }} />
            <div style={{ position: 'absolute', top: 2, right: 2, background: selected.has(i) ? 'var(--primary)' : 'rgba(0,0,0,0.4)', color: '#fff', padding: '1px 5px', borderRadius: 3, fontSize: 10 }}>
              {i + 1}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
