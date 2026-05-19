import { useEffect, useRef, useState } from 'react';

/**
 * Figma-style interactive overlay for OCR text layers.
 * - Each layer renders as a rectangle on the canvas.
 * - Single click → select.
 * - Drag (mousedown + move) → reposition (sets edited=true).
 * - Double click → inline edit text.
 * - Click outside → deselect.
 *
 * Props:
 *   layers           — array of { id, text, x, y, w, h, fontFamily, fontSize, fontWeight, color, bgColor, edited }
 *   offsetX, offsetY — display-pixel offset of the screen image inside the wrapper
 *   scale            — display scale; layer coords (image-px) * scale = display-px
 *   selectedId       — currently selected layer id, or null
 *   onSelect(id)
 *   onUpdate(id, patch) — patch is partial layer
 */
export default function TextLayersOverlay({
  layers,
  offsetX = 0,
  offsetY = 0,
  scale = 1,
  selectedId,
  onSelect,
  onUpdate,
}) {
  const [drag, setDrag] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [clickAt, setClickAt] = useState(0);

  useEffect(() => {
    if (!drag) return;
    let moved = false;
    const onMove = (e) => {
      const dx = (e.clientX - drag.sx) / scale;
      const dy = (e.clientY - drag.sy) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (!moved) return;
      onUpdate(drag.id, { x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy), edited: true });
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, scale, onUpdate]);

  return (
    <div
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      onClick={(e) => {
        // Click on empty area deselects
        if (e.target === e.currentTarget) onSelect?.(null);
      }}
    >
      {layers.map((l) => {
        const isSelected = selectedId === l.id;
        const isEditing = editingId === l.id;
        const x = offsetX + l.x * scale;
        const y = offsetY + l.y * scale;
        const w = l.w * scale;
        const h = l.h * scale;
        return (
          <LayerBox
            key={l.id}
            layer={l}
            x={x}
            y={y}
            w={w}
            h={h}
            scale={scale}
            isSelected={isSelected}
            isEditing={isEditing}
            onMouseDown={(e) => {
              if (isEditing) return;
              e.stopPropagation();
              const now = Date.now();
              const isDouble = now - clickAt < 300 && selectedId === l.id;
              setClickAt(now);
              if (isDouble) {
                setEditingId(l.id);
              } else {
                onSelect?.(l.id);
                setDrag({ id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y });
              }
            }}
            onTextChange={(text) => onUpdate(l.id, { text, edited: true })}
            onCommit={() => setEditingId(null)}
          />
        );
      })}
    </div>
  );
}

function LayerBox({ layer: l, x, y, w, h, scale, isSelected, isEditing, onMouseDown, onTextChange, onCommit }) {
  const inputRef = useRef(null);
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const border = isEditing
    ? '2px solid #3b82f6'
    : isSelected
    ? '2px solid #3b82f6'
    : l.edited
    ? '1px solid rgba(59,130,246,0.65)'
    : '1px dashed rgba(59,130,246,0.45)';
  const bg = isSelected && !isEditing ? 'rgba(59,130,246,0.07)' : 'transparent';

  return (
    <>
      <div
        onMouseDown={onMouseDown}
        title={isEditing ? '' : '클릭=선택, 드래그=이동, 더블클릭=텍스트 편집'}
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: w,
          height: h,
          border,
          background: bg,
          cursor: isEditing ? 'text' : 'move',
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          transition: 'border-color 0.1s',
        }}
      >
        {isEditing && (
          <input
            ref={inputRef}
            value={l.text}
            onChange={(e) => onTextChange(e.target.value)}
            onBlur={onCommit}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                onCommit();
              }
              e.stopPropagation();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              border: 'none',
              outline: 'none',
              background: l.bgColor || '#ffffff',
              color: l.color || '#111111',
              fontSize: Math.max(10, l.fontSize * scale),
              fontFamily: l.fontFamily,
              fontWeight: l.fontWeight,
              padding: 0,
              boxSizing: 'border-box',
              textAlign: 'left',
            }}
          />
        )}
      </div>
      {isSelected && !isEditing && (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: Math.max(0, y - 22),
            background: '#3b82f6',
            color: '#fff',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            pointerEvents: 'none',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
          }}
        >
          {l.text} · {l.fontName || ''} {l.fontSize}px
        </div>
      )}
    </>
  );
}
