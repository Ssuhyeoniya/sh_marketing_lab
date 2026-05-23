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
              onSelect?.(l.id);
              setDrag({ id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y });
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setDrag(null);
              onSelect?.(l.id);
              setEditingId(l.id);
            }}
            onTextChange={(text) => onUpdate(l.id, { text, edited: true })}
            onCommit={() => setEditingId(null)}
          />
        );
      })}
    </div>
  );
}

function LayerBox({ layer: l, x, y, w, h, scale, isSelected, isEditing, onMouseDown, onDoubleClick, onTextChange, onCommit }) {
  const inputRef = useRef(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Display fontSize in CSS px — match OCR/PDF-detected size exactly,
  // so the inline editor renders text at the same scale as the canvas output.
  const displayFontSize = (+l.fontSize || 14) * scale;
  // CSS line baseline sits ~80% from top of the line box at line-height = 1.
  // Move the input so its glyph baseline aligns with the layer's exact baseY.
  // ascent ratio of the source glyphs within the bbox:
  const ascentRatio = l.h > 0 ? (l.ascent ?? l.h * 0.82) / l.h : 0.82;
  // Vertical offset to compensate for CSS's default baseline placement (~0.8).
  const baselineNudge = (ascentRatio - 0.8) * h;

  // Border styles by state — all clearly visible.
  let border, bg;
  if (isEditing) {
    border = '2px solid #3b82f6';
    bg = 'rgba(59,130,246,0.06)';
  } else if (isSelected) {
    border = '2px solid #3b82f6';
    bg = 'rgba(59,130,246,0.10)';
  } else if (l.edited) {
    border = '1.5px solid #3b82f6';
    bg = 'rgba(59,130,246,0.05)';
  } else {
    // Default OCR-detected box: clearly visible cyan outline + light tint.
    border = hover ? '1.5px solid #06b6d4' : '1.5px dashed #22d3ee';
    bg = hover ? 'rgba(34,211,238,0.10)' : 'rgba(34,211,238,0.04)';
  }

  return (
    <>
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={isEditing ? '' : `"${l.text}" · 클릭=선택 · 드래그=이동 · 더블클릭=편집`}
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
          transition: 'background-color 0.1s, border-color 0.1s',
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
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: 0,
              top: baselineNudge,
              width: 'auto',
              minWidth: '100%',
              height: '100%',
              whiteSpace: 'nowrap',
              border: 'none',
              outline: 'none',
              background: l.bgColor || '#ffffff',
              color: l.color || '#111111',
              fontSize: displayFontSize,
              lineHeight: `${h}px`,
              fontFamily: l.fontFamily,
              fontWeight: l.fontWeight,
              letterSpacing: 0,
              padding: 0,
              margin: 0,
              boxSizing: 'border-box',
              textAlign: 'left',
              transform: l.angleDeg ? `rotate(${l.angleDeg}deg)` : undefined,
              transformOrigin: '0 100%',
            }}
          />
        )}
      </div>
      {/* Small corner ticks at each corner so very small boxes are still spotted. */}
      {!isEditing && !isSelected && (
        <>
          <CornerTick left={x} top={y} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x + w} top={y} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x} top={y + h} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x + w} top={y + h} color={l.edited ? '#3b82f6' : '#06b6d4'} />
        </>
      )}
      {(isSelected || hover) && !isEditing && (
        <div
          style={{
            position: 'absolute',
            left: x,
            top: Math.max(0, y - 22),
            background: isSelected ? '#3b82f6' : '#06b6d4',
            color: '#fff',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            pointerEvents: 'none',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        >
          {l.text} · {l.fontSize}px
        </div>
      )}
    </>
  );
}

function CornerTick({ left, top, color }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: left - 3,
        top: top - 3,
        width: 6,
        height: 6,
        background: color,
        borderRadius: 1,
        pointerEvents: 'none',
        boxShadow: '0 0 0 1px rgba(255,255,255,0.6)',
      }}
    />
  );
}
