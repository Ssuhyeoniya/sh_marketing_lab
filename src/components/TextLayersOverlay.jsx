import { useEffect, useRef, useState } from 'react';

/**
 * ezPDF-style interactive overlay for PDF/OCR text layers.
 * Behaviour is driven by `editMode`:
 *   - 'sentence'    : click=select+drag, double-click=edit whole line.
 *   - 'word'        : single click on a layer opens the editor with the word
 *                     under the cursor pre-selected (so retyping replaces it).
 *   - 'delete-text' : single click on a layer removes that text (covers it
 *                     with the sampled bg colour). Drag does nothing.
 *   - 'delete-area' : drag on empty canvas to paint a rectangular erase region
 *                     (covers everything inside, including images, with white).
 */
export default function TextLayersOverlay({
  layers,
  offsetX = 0,
  offsetY = 0,
  scale = 1,
  selectedId,
  onSelect,
  onUpdate,
  editMode = 'sentence',
  eraseRegions = [],
  onDeleteLayer,
  onAreaErase,
  onAreaEraseDelete,
  // Called once at the start of an atomic mutation (drag, edit, ...) so the
  // parent can snapshot the pre-mutation state into its undo history.
  onMutateStart,
}) {
  const [drag, setDrag] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingCaret, setEditingCaret] = useState(null); // [start, end] selection on focus
  const [areaDrag, setAreaDrag] = useState(null); // for delete-area mode

  // Exit edit mode when switching modes.
  useEffect(() => { setEditingId(null); setDrag(null); setAreaDrag(null); }, [editMode]);

  // Layer drag handler (sentence mode).
  useEffect(() => {
    if (!drag) return;
    let moved = false;
    let snapshotted = false;
    const onMove = (e) => {
      const dx = (e.clientX - drag.sx) / scale;
      const dy = (e.clientY - drag.sy) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (!moved) return;
      if (!snapshotted) { onMutateStart?.(); snapshotted = true; }
      // Position-only patch — do NOT mark `edited`. The redraw will lift the
      // original glyph bitmap from the source canvas instead of rasterising
      // the text with a web font, so the typography metric is preserved 1:1.
      onUpdate(drag.id, { x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy), moved: true });
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, scale, onUpdate, onMutateStart]);

  // Area-erase drag handler.
  useEffect(() => {
    if (!areaDrag || areaDrag.committed) return;
    const onMove = (e) => {
      setAreaDrag((d) => d && { ...d, cx: e.clientX, cy: e.clientY });
    };
    const onUp = () => {
      setAreaDrag((d) => {
        if (!d) return null;
        const rect = d.containerRect;
        const x1 = Math.min(d.sx, d.cx ?? d.sx) - rect.left;
        const y1 = Math.min(d.sy, d.cy ?? d.sy) - rect.top;
        const x2 = Math.max(d.sx, d.cx ?? d.sx) - rect.left;
        const y2 = Math.max(d.sy, d.cy ?? d.sy) - rect.top;
        const w = x2 - x1, h = y2 - y1;
        if (w > 4 && h > 4) {
          onAreaErase?.({
            x: Math.round(x1 / scale),
            y: Math.round(y1 / scale),
            w: Math.round(w / scale),
            h: Math.round(h / scale),
          });
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [areaDrag, scale, onAreaErase]);

  const wrapPointerEvents = editMode === 'delete-area' ? 'auto' : 'none';

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        pointerEvents: wrapPointerEvents,
        cursor: editMode === 'delete-area' ? 'crosshair' : 'default',
      }}
      onMouseDown={(e) => {
        if (editMode !== 'delete-area') return;
        if (e.target !== e.currentTarget) return; // don't start on erase-region overlays
        const rect = e.currentTarget.getBoundingClientRect();
        setAreaDrag({ sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, containerRect: rect });
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && editMode !== 'delete-area') onSelect?.(null);
      }}
    >
      {/* Existing erase regions — clickable in delete-area mode to remove. */}
      {eraseRegions.map((r, i) => (
        <div
          key={`er-${i}`}
          onClick={(e) => {
            if (editMode !== 'delete-area') return;
            e.stopPropagation();
            onAreaEraseDelete?.(i);
          }}
          title={editMode === 'delete-area' ? '클릭하여 영역 삭제 취소' : undefined}
          style={{
            position: 'absolute',
            left: offsetX + r.x * scale,
            top: offsetY + r.y * scale,
            width: r.w * scale,
            height: r.h * scale,
            background: 'rgba(239,68,68,0.10)',
            border: '1.5px dashed #ef4444',
            pointerEvents: editMode === 'delete-area' ? 'auto' : 'none',
            cursor: editMode === 'delete-area' ? 'not-allowed' : 'default',
            boxSizing: 'border-box',
          }}
        />
      ))}

      {/* In-progress area-erase rect */}
      {areaDrag && (
        <div style={areaRectStyle(areaDrag)} />
      )}

      {layers.map((l) => {
        if (l.visible === false) return null;
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
            editMode={editMode}
            caretRange={isEditing ? editingCaret : null}
            onMouseDown={(e) => {
              if (isEditing) return;
              if (editMode === 'delete-area') return;
              e.stopPropagation();
              if (editMode === 'delete-text') {
                onDeleteLayer?.(l.id);
                return;
              }
              if (editMode === 'word') {
                onSelect?.(l.id);
                const cRect = e.currentTarget.getBoundingClientRect();
                const relClickX = e.clientX - cRect.left;
                const text = l.text || '';
                let sel = null;
                // Best: use OCR-detected word bboxes when present — they
                // were captured from Tesseract per-word boxes inside the
                // line and give pixel-accurate boundaries.
                if (l.words && l.words.length && l.originalW) {
                  const px = (relClickX / cRect.width) * l.originalW; // tight-bbox px
                  const baseX = 0; // offsets are relative to layer's originalX
                  const clickAbsX = (l.originalX ?? l.x) + px;
                  const hit = l.words.find((w) =>
                    w.bbox && clickAbsX >= w.bbox.x0 - 2 && clickAbsX <= w.bbox.x1 + 2
                  );
                  if (hit && hit.text) {
                    const idx = text.indexOf(hit.text);
                    if (idx >= 0) sel = [idx, idx + hit.text.length];
                  }
                }
                // Fallback: proportional click-to-char with word-boundary expand.
                if (!sel) {
                  const isWordCh = (ch) => /[\p{L}\p{N}_가-힣]/u.test(ch);
                  const approxIdx = Math.max(
                    0,
                    Math.min(text.length, Math.round((relClickX / cRect.width) * text.length))
                  );
                  let s = approxIdx, end = approxIdx;
                  while (s > 0 && isWordCh(text[s - 1])) s--;
                  while (end < text.length && isWordCh(text[end])) end++;
                  sel = s === end ? [0, text.length] : [s, end];
                }
                onMutateStart?.();
                setEditingCaret(sel);
                setEditingId(l.id);
                return;
              }
              // sentence mode: select + start drag
              onSelect?.(l.id);
              setDrag({ id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y });
            }}
            onDoubleClick={(e) => {
              if (editMode === 'delete-text' || editMode === 'delete-area') return;
              e.stopPropagation();
              e.preventDefault();
              setDrag(null);
              onSelect?.(l.id);
              onMutateStart?.();
              setEditingCaret(null); // null → select all
              setEditingId(l.id);
            }}
            onTextChange={(text) => onUpdate(l.id, { text, edited: true })}
            onCommit={() => { setEditingId(null); setEditingCaret(null); }}
          />
        );
      })}
    </div>
  );
}

function areaRectStyle(d) {
  const rect = d.containerRect;
  const x1 = Math.min(d.sx, d.cx) - rect.left;
  const y1 = Math.min(d.sy, d.cy) - rect.top;
  const x2 = Math.max(d.sx, d.cx) - rect.left;
  const y2 = Math.max(d.sy, d.cy) - rect.top;
  return {
    position: 'absolute',
    left: x1, top: y1, width: x2 - x1, height: y2 - y1,
    background: 'rgba(239,68,68,0.18)',
    border: '1.5px dashed #ef4444',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  };
}

function LayerBox({ layer: l, x, y, w, h, scale, isSelected, isEditing, editMode, caretRange, onMouseDown, onDoubleClick, onTextChange, onCommit }) {
  const inputRef = useRef(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      if (caretRange && caretRange.length === 2) {
        try { inputRef.current.setSelectionRange(caretRange[0], caretRange[1]); } catch {}
      } else {
        // Place the cursor at the END of the text — never auto-select-all.
        // Selecting all on focus meant any accidental keystroke wiped the
        // original line, which felt like "the text suddenly changed".
        const len = inputRef.current.value.length;
        try { inputRef.current.setSelectionRange(len, len); } catch {}
      }
    }
  }, [isEditing, caretRange]);

  const displayFontSize = (+l.fontSize || 14) * scale;
  const lineH = displayFontSize;
  const baselineNudge = Math.max(0, (h - lineH) / 2);
  // Visual padding — expands the CLICKABLE frame outside the tight glyph
  // bbox so tight table cells are easier to grab. Layer data (x/y/w/h)
  // stays tight, so drawTextOverlay's baseline math and canvas-text
  // alignment are unaffected. The inner input is pushed back by the same
  // amount to keep its glyphs perfectly stacked over the canvas glyphs.
  const PAD = 3;

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
  } else if (editMode === 'delete-text') {
    border = hover ? '1.5px solid #ef4444' : '1.5px dashed #fca5a5';
    bg = hover ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.04)';
  } else {
    border = hover ? '1.5px solid #06b6d4' : '1.5px dashed #22d3ee';
    bg = hover ? 'rgba(34,211,238,0.10)' : 'rgba(34,211,238,0.04)';
  }

  const cursor =
    isEditing ? 'text' :
    editMode === 'delete-text' ? 'not-allowed' :
    editMode === 'delete-area' ? 'crosshair' :
    editMode === 'word' ? 'text' :
    'move';

  return (
    <>
      <div
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={isEditing ? '' : titleForMode(editMode, l.text)}
        style={{
          position: 'absolute',
          left: x - PAD,
          top: y - PAD,
          width: w + PAD * 2,
          height: h + PAD * 2,
          border,
          background: bg,
          cursor,
          pointerEvents: editMode === 'delete-area' ? 'none' : 'auto',
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
              // Compensate for the box's visual padding so the input glyphs
              // sit exactly above the canvas glyphs underneath.
              left: PAD,
              top: PAD + baselineNudge,
              width: 'auto',
              minWidth: '100%',
              height: `${lineH}px`,
              whiteSpace: 'nowrap',
              border: 'none',
              outline: 'none',
              background: l.bgColor || '#ffffff',
              color: l.color || '#111111',
              fontSize: displayFontSize,
              lineHeight: `${lineH}px`,
              fontFamily: l.fontFamily,
              fontWeight: l.fontWeight,
              // Preserve the PDF's letter-spacing (Tc) and synthetic italic
              // skew so the inline editor matches the canvas output exactly.
              letterSpacing: l.letterSpacing ? `${l.letterSpacing * scale}px` : 0,
              padding: 0,
              margin: 0,
              boxSizing: 'border-box',
              textAlign: l.textAlign || 'left',
              transform: [
                l.angleDeg ? `rotate(${l.angleDeg}deg)` : '',
                l.skewXDeg ? `skewX(${-l.skewXDeg}deg)` : '',
              ].filter(Boolean).join(' ') || undefined,
              transformOrigin: '0 100%',
            }}
          />
        )}
      </div>
      {!isEditing && !isSelected && editMode !== 'delete-text' && (
        <>
          <CornerTick left={x - PAD} top={y - PAD} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x + w + PAD} top={y - PAD} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x - PAD} top={y + h + PAD} color={l.edited ? '#3b82f6' : '#06b6d4'} />
          <CornerTick left={x + w + PAD} top={y + h + PAD} color={l.edited ? '#3b82f6' : '#06b6d4'} />
        </>
      )}
      {(isSelected || hover) && !isEditing && (
        <div
          style={{
            position: 'absolute',
            left: x - PAD,
            top: Math.max(0, y - PAD - 22),
            background: editMode === 'delete-text' ? '#ef4444' : (isSelected ? '#3b82f6' : '#06b6d4'),
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
          {labelForMode(editMode, l)}
        </div>
      )}
    </>
  );
}

function titleForMode(mode, text) {
  if (mode === 'delete-text') return `클릭하여 "${text}" 삭제`;
  if (mode === 'word') return `클릭한 단어만 편집 — "${text}"`;
  if (mode === 'delete-area') return '드래그하여 영역 선택';
  return `"${text}" · 클릭=선택 · 드래그=이동 · 더블클릭=문장 편집`;
}
function labelForMode(mode, l) {
  if (mode === 'delete-text') return `삭제: ${l.text}`;
  if (mode === 'word') return `단어 클릭하여 편집 · ${Math.round(l.fontSize)}px`;
  return `${l.text} · ${Math.round(l.fontSize)}px`;
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
