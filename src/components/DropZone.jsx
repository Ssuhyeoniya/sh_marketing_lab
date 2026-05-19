import { useRef, useState } from 'react';

export default function DropZone({ accept, multiple = false, onFiles, hint, label }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  const handle = (files) => {
    if (!files || !files.length) return;
    onFiles([...files]);
  };

  return (
    <>
      <div
        className={'drop' + (over ? ' over' : '')}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle(e.dataTransfer.files);
        }}
      >
        <div className="icon">↑</div>
        <div style={{ fontSize: 13 }}>{label || '여기에 드래그하거나 클릭해서 업로드'}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => handle(e.target.files)}
      />
    </>
  );
}
