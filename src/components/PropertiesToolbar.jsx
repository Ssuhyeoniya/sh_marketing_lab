import { memo, useCallback } from 'react';

/**
 * Top properties toolbar — Hancom-style, replaces the previous full-list
 * right panel. Reads only the currently selected layer; aggressively
 * memoised so changes to OTHER layers (drag, OCR progress, page redraw)
 * never re-render it.
 *
 * Performance notes
 *   - React.memo's custom comparator below checks ONLY the layer fields the
 *     toolbar actually reads. Layer.x / layer.y changes (which fire on every
 *     mousemove during a drag) don't pass through, so dragging stays smooth.
 *   - Handlers are wrapped in useCallback (with no closures over layer.text
 *     etc.) so identity is stable across renders, letting child controls
 *     skip render passes too.
 */
function PropertiesToolbar({
  layer,
  fontOptions,
  onUpdate,
  onMutateStart,
  onDelete,
}) {
  const disabled = !layer;

  const startEditCommit = useCallback(() => {
    onMutateStart?.();
  }, [onMutateStart]);

  const patch = useCallback((p) => {
    if (!layer) return;
    onUpdate?.(layer.id, p);
  }, [layer, onUpdate]);

  const onFontChange = useCallback((e) => {
    const o = fontOptions.find((f) => f.name === e.target.value);
    if (o) patch({ fontName: o.name, fontFamily: o.family, fontWeight: o.weight });
  }, [fontOptions, patch]);

  const bumpSize = useCallback((dir) => {
    if (!layer) return;
    startEditCommit();
    const next = Math.max(4, Math.min(400, Math.round((+layer.fontSize || 14) + dir)));
    patch({ fontSize: next });
  }, [layer, patch, startEditCommit]);

  const toggleBold = useCallback(() => {
    startEditCommit();
    patch({ isBold: !layer.isBold, fontWeight: !layer.isBold ? 700 : 400 });
  }, [layer, patch, startEditCommit]);

  const toggleItalic = useCallback(() => {
    startEditCommit();
    patch({ isItalic: !layer.isItalic, skewXDeg: !layer.isItalic ? 10 : 0 });
  }, [layer, patch, startEditCommit]);

  const setAlign = useCallback((a) => {
    startEditCommit();
    patch({ textAlign: a });
  }, [patch, startEditCommit]);

  return (
    <div className={'props-toolbar' + (disabled ? ' is-disabled' : '')}>
      {disabled && (
        <div className="props-hint">텍스트를 선택하면 여기에서 속성을 편집할 수 있어요</div>
      )}
      {!disabled && (
        <>
          {/* Font + size group */}
          <select
            className="props-font"
            value={layer.fontName}
            onFocus={startEditCommit}
            onChange={onFontChange}
            title="폰트"
          >
            {fontOptions.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
          <input
            type="number"
            className="props-size"
            value={Math.round(layer.fontSize)}
            min={4}
            max={400}
            onFocus={startEditCommit}
            onChange={(e) => patch({ fontSize: +e.target.value })}
            title="크기"
          />
          <button type="button" className="props-icon" onClick={() => bumpSize(+1)} title="크기 +1">가＋</button>
          <button type="button" className="props-icon" onClick={() => bumpSize(-1)} title="크기 −1">가－</button>

          <span className="props-sep" />

          {/* Style group */}
          <button
            type="button"
            className={'props-icon' + (layer.isBold ? ' on' : '')}
            onClick={toggleBold}
            title="굵게 (B)"
            style={{ fontWeight: 700 }}
          >B</button>
          <button
            type="button"
            className={'props-icon' + (layer.isItalic ? ' on' : '')}
            onClick={toggleItalic}
            title="기울임 (I)"
            style={{ fontStyle: 'italic' }}
          >I</button>

          <span className="props-sep" />

          {/* Alignment group */}
          <button type="button" className={'props-icon' + ((layer.textAlign || 'left') === 'left' ? ' on' : '')} onClick={() => setAlign('left')} title="왼쪽 정렬">≡</button>
          <button type="button" className={'props-icon' + (layer.textAlign === 'center' ? ' on' : '')} onClick={() => setAlign('center')} title="가운데 정렬">≣</button>
          <button type="button" className={'props-icon' + (layer.textAlign === 'right' ? ' on' : '')} onClick={() => setAlign('right')} title="오른쪽 정렬">≡</button>

          <span className="props-sep" />

          {/* Colour group */}
          <label className="props-color" title="글자 색">
            <span className="props-color-label" style={{ color: rgbToHex(layer.color) }}>가</span>
            <input
              type="color"
              value={rgbToHex(layer.color)}
              onFocus={startEditCommit}
              onChange={(e) => patch({ color: e.target.value })}
            />
          </label>
          <label className="props-color" title="배경 색">
            <span className="props-color-label" style={{ background: rgbToHex(layer.bgColor || '#ffffff'), border: '1px solid #ddd' }}>＿</span>
            <input
              type="color"
              value={rgbToHex(layer.bgColor || '#ffffff')}
              onFocus={startEditCommit}
              onChange={(e) => patch({ bgColor: e.target.value })}
            />
          </label>

          <span className="props-sep" />

          {/* Letter spacing */}
          <div className="props-field" title="자간 (Tc)">
            <span className="props-label">자간</span>
            <input
              type="number"
              step="0.1"
              className="props-size"
              value={Number((layer.letterSpacing || 0).toFixed(2))}
              onFocus={startEditCommit}
              onChange={(e) => patch({ letterSpacing: +e.target.value })}
            />
          </div>

          <span className="props-flex" />

          {/* Status chips + delete */}
          {layer.source === 'pdf' && layer.pdfFamily && <span className="props-chip">PDF embed</span>}
          {layer.source === 'ocr' && <span className="props-chip warn">OCR</span>}
          {layer.edited && <span className="props-chip primary">편집됨</span>}
          {layer.moved && !layer.edited && <span className="props-chip">이동됨</span>}
          <button type="button" className="props-icon danger" onClick={onDelete} title="이 텍스트 삭제">✕</button>
        </>
      )}
    </div>
  );
}

function rgbToHex(s) {
  if (!s) return '#000000';
  if (s.startsWith('#')) return s.length === 7 ? s : '#000000';
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
}

// Only re-render when the toolbar's read inputs actually change. Drag
// patches (x/y) and other layers' changes are dropped here, so the lag-
// inducing per-keystroke render cascade is gone.
const TOOLBAR_KEYS = [
  'id', 'fontName', 'fontFamily', 'fontSize', 'fontWeight',
  'isBold', 'isItalic', 'color', 'bgColor', 'letterSpacing',
  'textAlign', 'source', 'pdfFamily', 'edited', 'moved',
];

export default memo(PropertiesToolbar, (prev, next) => {
  if (prev.onUpdate !== next.onUpdate) return false;
  if (prev.onMutateStart !== next.onMutateStart) return false;
  if (prev.onDelete !== next.onDelete) return false;
  if (prev.fontOptions !== next.fontOptions) return false;
  const a = prev.layer, b = next.layer;
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of TOOLBAR_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
});
