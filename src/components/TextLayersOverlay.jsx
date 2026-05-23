import { memo, useCallback, useEffect, useRef, useState } from 'react';

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
 *
 * Performance
 *   - Each `LayerBox` is wrapped in `React.memo` with a custom comparator that
 *     watches only the fields it actually paints. A drag mutation patches a
 *     single layer's x/y; sibling layers retain reference identity from
 *     `update()` in TextEdit so their memoised boxes skip render entirely.
 *   - Per-layer event handlers are stable `useCallback`s that read the layer
 *     from the event target's dataset, so no closures over the current layer
 *     are recreated each render — keeping `LayerBox` props identity-stable.
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
  // Notify parent that an active drag started / stopped — parent uses this to
  // skip its expensive canvas redraw effect while the user is dragging. The
  // HTML overlay box shows the new position via CSS in real time; the canvas
  // is re-rasterised once on drag end.
  onDragActiveChange,
}) {
  const [drag, setDrag] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editingCaret, setEditingCaret] = useState(null); // [start, end] selection on focus
  const [areaDrag, setAreaDrag] = useState(null); // for delete-area mode

  // Latest layers in a ref so stable callbacks can resolve a layer by id
  // without invalidating their identity on every render.
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Stable refs for the parent-supplied callbacks. The callbacks are recreated
  // on every TextEdit render (they're not memoised), so depending on them in
  // the drag effect would re-run the effect on every layer patch — and a
  // mid-drag re-run resets the effect's local `notifiedActive`/`moved`/
  // `snapshotted` flags, which caused mouseup-after-rerender to skip the
  // "drag ended" notification and leave the parent's `dragActiveRef` stuck
  // at true. The next user drag would then never trigger a canvas redraw,
  // which is what the "두 번째 이동이 안 된다" bug was — second move worked
  // in state but the canvas redraw was suppressed.
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onMutateStartRef = useRef(onMutateStart);
  onMutateStartRef.current = onMutateStart;
  const onDragActiveChangeRef = useRef(onDragActiveChange);
  onDragActiveChangeRef.current = onDragActiveChange;
  const onAreaEraseRef = useRef(onAreaErase);
  onAreaEraseRef.current = onAreaErase;
  // Drag-internal flags must survive effect re-runs too. They reset when the
  // drag state itself transitions to null (drag ended).
  const dragNotifiedRef = useRef(false);
  const dragMovedRef = useRef(false);
  const dragSnapshottedRef = useRef(false);

  // Exit edit mode when switching modes.
  useEffect(() => { setEditingId(null); setDrag(null); setAreaDrag(null); }, [editMode]);

  // Drag lifecycle — fires ONCE on drag end, regardless of how many times
  // the listener effect below re-ran during the drag.
  useEffect(() => {
    if (!drag) {
      if (dragNotifiedRef.current) {
        dragNotifiedRef.current = false;
        dragMovedRef.current = false;
        dragSnapshottedRef.current = false;
        onDragActiveChangeRef.current?.(false);
      }
    }
  }, [drag]);

  // Layer drag listener (sentence mode). Depends ONLY on `drag` and `scale`
  // now — the parent callbacks are accessed through refs so identity churn
  // doesn't re-trigger the effect mid-drag.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const dx = (e.clientX - drag.sx) / scale;
      const dy = (e.clientY - drag.sy) / scale;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMovedRef.current = true;
      if (!dragMovedRef.current) return;
      if (!dragSnapshottedRef.current) {
        onMutateStartRef.current?.();
        dragSnapshottedRef.current = true;
      }
      if (!dragNotifiedRef.current) {
        dragNotifiedRef.current = true;
        onDragActiveChangeRef.current?.(true);
      }
      // Position-only patch — do NOT mark `edited`. The redraw will lift the
      // original glyph bitmap from the source canvas instead of rasterising
      // the text with a web font, so the typography metric is preserved 1:1.
      onUpdateRef.current?.(drag.id, {
        x: Math.round(drag.ox + dx),
        y: Math.round(drag.oy + dy),
        moved: true,
      });
    };
    const onUp = () => setDrag(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, scale]);

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

  // ── Stable per-layer event handlers ──────────────────────────────────────
  // These read `layersRef.current` to resolve the layer id → layer object,
  // so the function identity stays the same across renders. That lets the
  // `LayerBox` memo comparator skip re-rendering siblings during a drag.
  const handleLayerMouseDown = useCallback((id, e) => {
    const l = layersRef.current.find((x) => x.id === id);
    if (!l) return;
    if (editMode === 'delete-area') return;
    e.stopPropagation();
    if (editMode === 'delete-text') {
      onDeleteLayer?.(id);
      return;
    }
    if (editMode === 'word') {
      onSelect?.(id);
      const cRect = e.currentTarget.getBoundingClientRect();
      const relClickX = e.clientX - cRect.left;
      const text = l.text || '';
      let sel = null;
      if (l.words && l.words.length && l.originalW) {
        const px = (relClickX / cRect.width) * l.originalW;
        const clickAbsX = (l.originalX ?? l.x) + px;
        const hit = l.words.find((w) =>
          w.bbox && clickAbsX >= w.bbox.x0 - 2 && clickAbsX <= w.bbox.x1 + 2
        );
        if (hit && hit.text) {
          const idx = text.indexOf(hit.text);
          if (idx >= 0) sel = [idx, idx + hit.text.length];
        }
      }
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
      setEditingId(id);
      return;
    }
    // sentence mode: select + start drag
    onSelect?.(id);
    setDrag({ id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y });
  }, [editMode, onSelect, onDeleteLayer, onMutateStart]);

  const handleLayerDoubleClick = useCallback((id, e) => {
    if (editMode === 'delete-text' || editMode === 'delete-area') return;
    e.stopPropagation();
    e.preventDefault();
    setDrag(null);
    onSelect?.(id);
    onMutateStart?.();
    setEditingCaret(null); // null → place cursor at end inside LayerBox
    setEditingId(id);
  }, [editMode, onSelect, onMutateStart]);

  const handleTextChange = useCallback((id, text) => {
    onUpdate(id, { text, edited: true });
  }, [onUpdate]);

  const handleCommit = useCallback(() => {
    setEditingId(null);
    setEditingCaret(null);
  }, []);

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
        return (
          <LayerBox
            key={l.id}
            layer={l}
            offsetX={offsetX}
            offsetY={offsetY}
            scale={scale}
            isSelected={isSelected}
            isEditing={isEditing}
            editMode={editMode}
            caretRange={isEditing ? editingCaret : null}
            onMouseDown={handleLayerMouseDown}
            onDoubleClick={handleLayerDoubleClick}
            onTextChange={handleTextChange}
            onCommit={handleCommit}
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

// Fields whose change must trigger a LayerBox re-render. Excludes ephemeral
// data the box doesn't paint (e.g. `pdfFamily`, `originalX`) so memo skips
// purely-internal patches.
const LAYERBOX_FIELDS = [
  'x', 'y', 'w', 'h', 'text', 'fontSize', 'fontFamily', 'fontWeight',
  'letterSpacing', 'color', 'bgColor', 'isBold', 'isItalic', 'edited', 'moved',
  'visible', 'textAlign', 'angleDeg', 'skewXDeg',
];

function LayerBoxRaw({ layer: l, offsetX, offsetY, scale, isSelected, isEditing, editMode, caretRange, onMouseDown, onDoubleClick, onTextChange, onCommit }) {
  const inputRef = useRef(null);
  const [hover, setHover] = useState(false);

  // Resolve canvas-px to screen-px inside the box itself so the parent doesn't
  // re-compute x/y/w/h on every render — only the layer reference matters.
  const x = offsetX + l.x * scale;
  const y = offsetY + l.y * scale;
  const w = l.w * scale;
  const h = l.h * scale;

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      if (caretRange && caretRange.length === 2) {
        try { inputRef.current.setSelectionRange(caretRange[0], caretRange[1]); } catch {}
      } else {
        const len = inputRef.current.value.length;
        try { inputRef.current.setSelectionRange(len, len); } catch {}
      }
    }
  }, [isEditing, caretRange]);

  const displayFontSize = (+l.fontSize || 14) * scale;
  const lineH = displayFontSize;
  const baselineNudge = Math.max(0, (h - lineH) / 2);
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
        onMouseDown={(e) => { if (!isEditing) onMouseDown(l.id, e); }}
        onDoubleClick={(e) => onDoubleClick(l.id, e)}
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
            onChange={(e) => onTextChange(l.id, e.target.value)}
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
              left: PAD,
              top: PAD + baselineNudge,
              width: `calc(100% - ${PAD * 2}px)`,
              height: `${lineH}px`,
              whiteSpace: 'nowrap',
              border: 'none',
              outline: 'none',
              // Transparent by default — only paint a solid background
              // when the user has explicitly chosen one (matches the
              // canvas-side rule in drawTextOverlay).
              background: l.bgColorEdited && l.bgColor ? l.bgColor : 'transparent',
              color: l.color || '#111111',
              fontSize: displayFontSize,
              lineHeight: `${lineH}px`,
              fontFamily: l.fontFamily,
              fontWeight: l.fontWeight,
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

const LayerBox = memo(LayerBoxRaw, (prev, next) => {
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isEditing !== next.isEditing) return false;
  if (prev.editMode !== next.editMode) return false;
  if (prev.scale !== next.scale) return false;
  if (prev.offsetX !== next.offsetX || prev.offsetY !== next.offsetY) return false;
  if (prev.caretRange !== next.caretRange) return false;
  if (prev.onMouseDown !== next.onMouseDown) return false;
  if (prev.onDoubleClick !== next.onDoubleClick) return false;
  if (prev.onTextChange !== next.onTextChange) return false;
  if (prev.onCommit !== next.onCommit) return false;
  const a = prev.layer, b = next.layer;
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of LAYERBOX_FIELDS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
});

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
