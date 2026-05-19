import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import Stepper from '../../components/Stepper';
import DropZone from '../../components/DropZone';
import { loadImage, fileToDataURL, resizeToWidth, canvasToBlob } from '../../utils/image';
import { recognizeImage, guessFont } from '../../utils/ocr';
import {
  IPhoneFrameSvg,
  SCREEN_W,
  SCREEN_H,
  SCREEN_X,
  SCREEN_Y,
  FRAME_W,
  FRAME_H,
} from './IphoneFrame';
import { downloadBlob } from '../../utils/pdf';

const MAX_IMAGES = 20;

export default function IphoneMockup() {
  const [frameMode, setFrameMode] = useState('svg'); // 'svg' | 'png'
  const [customFrame, setCustomFrame] = useState(null); // { canvas, screenRect }
  const [items, setItems] = useState([]); // [{id, name, originalUrl, fittedCanvas, textLayers: [], ocrDone: bool}]
  const [activeId, setActiveId] = useState(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const active = items.find((i) => i.id === activeId);
  const step = items.length === 0 ? 0 : !active?.ocrDone ? 1 : 2;

  const showToast = (msg, ms = 2200) => {
    setToast(msg);
    setTimeout(() => setToast(''), ms);
  };

  // ---- Upload + resize to width 512 ----
  const onUpload = async (files) => {
    const remaining = MAX_IMAGES - items.length;
    if (remaining <= 0) return showToast(`최대 ${MAX_IMAGES}장까지 업로드 가능합니다`);
    const accepted = files.slice(0, remaining);
    setBusy(true);
    const next = [];
    for (const f of accepted) {
      const url = await fileToDataURL(f);
      const img = await loadImage(url);
      // Always resize so width matches SCREEN_W (512). Height scales proportionally.
      const fitted = await resizeToWidth(img, SCREEN_W);
      next.push({
        id: crypto.randomUUID(),
        name: f.name,
        originalUrl: url,
        originalW: img.naturalWidth,
        originalH: img.naturalHeight,
        fittedCanvas: fitted,
        textLayers: [],
        ocrDone: false,
      });
    }
    const merged = [...items, ...next];
    setItems(merged);
    if (!activeId && merged.length) setActiveId(merged[0].id);
    setBusy(false);
    if (files.length > remaining) {
      showToast(`최대 ${MAX_IMAGES}장 제한으로 ${files.length - remaining}장은 추가되지 않았습니다`);
    }
  };

  // ---- PNG frame upload ----
  const onFrameUpload = async (files) => {
    const f = files[0];
    if (!f) return;
    const url = await fileToDataURL(f);
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Auto-detect screen rect = bounding box of (mostly) transparent pixels.
    const rect = detectTransparentRect(ctx, canvas.width, canvas.height);
    setCustomFrame({ canvas, screenRect: rect });
    setFrameMode('png');
    showToast('프레임 인식 완료. 화면 영역을 자동으로 감지했습니다.');
  };

  // ---- OCR on active image ----
  const runOcr = async () => {
    if (!active) return;
    setBusy(true);
    setOcrProgress(0);
    const data = await recognizeImage(active.fittedCanvas, (p) => {
      if (p && p.progress != null) setOcrProgress(Math.round(p.progress * 100));
    });
    const layers = (data.words || [])
      .filter((w) => w.text && w.text.trim() && w.confidence > 30)
      .map((w) => {
        const guess = guessFont(w, active.fittedCanvas);
        // Sample background color from a tiny strip just above the word
        const bg = sampleBg(active.fittedCanvas, w.bbox);
        // Sample text color from inside bbox (darkest area)
        const fg = sampleFg(active.fittedCanvas, w.bbox);
        return {
          id: crypto.randomUUID(),
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          fontFamily: guess.font.family,
          fontName: guess.font.name,
          fontSize: guess.size,
          fontWeight: guess.weight,
          color: fg,
          bgColor: bg,
          visible: true,
        };
      });
    setItems((it) =>
      it.map((x) => (x.id === active.id ? { ...x, textLayers: layers, ocrDone: true } : x))
    );
    setBusy(false);
    showToast(`텍스트 ${layers.length}개 인식 완료`);
  };

  const updateLayer = (lid, patch) => {
    setItems((it) =>
      it.map((x) =>
        x.id !== active.id
          ? x
          : { ...x, textLayers: x.textLayers.map((l) => (l.id === lid ? { ...l, ...patch } : l)) }
      )
    );
  };
  const deleteLayer = (lid) => {
    setItems((it) =>
      it.map((x) =>
        x.id !== active.id ? x : { ...x, textLayers: x.textLayers.filter((l) => l.id !== lid) }
      )
    );
  };

  const removeItem = (id) => {
    setItems((it) => it.filter((x) => x.id !== id));
    if (activeId === id) {
      const remaining = items.filter((x) => x.id !== id);
      setActiveId(remaining[0]?.id || null);
    }
  };

  // ---- Composition ----
  const composeOne = async (item) => {
    // Step 1: build the screen canvas (512 x 1031) — image with edited text overlaid.
    const screen = document.createElement('canvas');
    screen.width = SCREEN_W;
    screen.height = SCREEN_H;
    const sctx = screen.getContext('2d');
    // Background fill (in case image is shorter than 1031)
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    // Draw the fitted image (width 512). Center vertically if shorter than 1031, else top-aligned crop to 1031.
    const ih = item.fittedCanvas.height;
    if (ih <= SCREEN_H) {
      sctx.drawImage(item.fittedCanvas, 0, 0);
    } else {
      // Top-aligned, crop overflow.
      sctx.drawImage(item.fittedCanvas, 0, 0, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
    }
    // Overlay edited text: for each layer, paint over original then draw text.
    item.textLayers
      .filter((l) => l.visible)
      .forEach((l) => {
        sctx.fillStyle = l.bgColor || '#ffffff';
        sctx.fillRect(l.x - 1, l.y - 1, l.w + 2, l.h + 2);
        sctx.fillStyle = l.color || '#111111';
        sctx.font = `${l.fontWeight || 400} ${l.fontSize || 14}px ${l.fontFamily}`;
        sctx.textBaseline = 'top';
        sctx.fillText(l.text, l.x, l.y);
      });

    // Step 2: composite onto frame.
    if (frameMode === 'svg') {
      // Render SVG frame to a canvas using an XML serializer.
      const out = document.createElement('canvas');
      out.width = FRAME_W;
      out.height = FRAME_H;
      const octx = out.getContext('2d');
      // Draw SVG frame as background by rasterizing it
      const svgEl = document.getElementById('iphone-frame-svg-template');
      if (svgEl) {
        const xml = new XMLSerializer().serializeToString(svgEl);
        const svgBlob = new Blob([xml], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(svgBlob);
        const fimg = await loadImage(url);
        URL.revokeObjectURL(url);
        octx.drawImage(fimg, 0, 0, FRAME_W, FRAME_H);
      }
      // Draw screen with rounded mask
      octx.save();
      roundedRectPath(octx, SCREEN_X, SCREEN_Y, SCREEN_W, SCREEN_H, 36);
      octx.clip();
      octx.drawImage(screen, SCREEN_X, SCREEN_Y);
      octx.restore();
      // Dynamic island on top
      octx.fillStyle = '#000';
      roundedRectPath(octx, FRAME_W / 2 - 60, SCREEN_Y + 12, 120, 34, 17);
      octx.fill();
      return out;
    } else if (customFrame) {
      const out = document.createElement('canvas');
      out.width = customFrame.canvas.width;
      out.height = customFrame.canvas.height;
      const octx = out.getContext('2d');
      // Draw screen first, then frame on top
      const { x, y, w, h } = customFrame.screenRect;
      octx.drawImage(screen, 0, 0, SCREEN_W, SCREEN_H, x, y, w, h);
      octx.drawImage(customFrame.canvas, 0, 0);
      return out;
    }
    return screen;
  };

  const downloadActive = async () => {
    if (!active) return;
    setBusy(true);
    const c = await composeOne(active);
    const blob = await canvasToBlob(c, 'image/png');
    downloadBlob(blob, `mockup-${stripExt(active.name)}.png`, 'image/png');
    setBusy(false);
  };

  const downloadAllZip = async () => {
    if (!items.length) return;
    setBusy(true);
    const zip = new JSZip();
    for (let i = 0; i < items.length; i++) {
      const c = await composeOne(items[i]);
      const blob = await canvasToBlob(c, 'image/png');
      zip.file(`mockup-${String(i + 1).padStart(2, '0')}-${stripExt(items[i].name)}.png`, blob);
    }
    const out = await zip.generateAsync({ type: 'blob' });
    downloadBlob(out, `iphone-mockups-${Date.now()}.zip`, 'application/zip');
    setBusy(false);
    showToast(`${items.length}개 ZIP 다운로드 완료`);
  };

  return (
    <div className="content" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Hidden SVG template used for compositing */}
      <div style={{ position: 'absolute', left: -99999, top: -99999 }}>
        <svg id="iphone-frame-svg-template" width={FRAME_W} height={FRAME_H} viewBox={`0 0 ${FRAME_W} ${FRAME_H}`} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#3a3d44" />
              <stop offset="0.5" stopColor="#1f2126" />
              <stop offset="1" stopColor="#2c2f36" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={FRAME_W} height={FRAME_H} rx="48" ry="48" fill="url(#g1)" />
          <rect x={SCREEN_X - 2} y={SCREEN_Y - 2} width={SCREEN_W + 4} height={SCREEN_H + 4} rx="38" ry="38" fill="#0a0a0a" />
          <rect x="-2" y="160" width="4" height="40" fill="#15171b" rx="1" />
          <rect x="-2" y="240" width="4" height="68" fill="#15171b" rx="1" />
          <rect x="-2" y="328" width="4" height="68" fill="#15171b" rx="1" />
          <rect x={FRAME_W - 2} y="220" width="4" height="100" fill="#15171b" rx="1" />
        </svg>
      </div>

      {/* Stepper + frame mode + actions */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <Stepper steps={['업로드', '편집 / 텍스트 인식', '미리보기', '다운로드']} current={step} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4, padding: 3, background: '#f4f4f5', borderRadius: 6 }}>
            <button
              className={'btn sm ' + (frameMode === 'svg' ? 'primary' : '')}
              style={frameMode === 'svg' ? {} : { background: 'transparent', border: 'none' }}
              onClick={() => setFrameMode('svg')}
            >
              기본 프레임
            </button>
            <FrameUploadButton onUpload={onFrameUpload} active={frameMode === 'png'} />
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {items.length} / {MAX_IMAGES}
          </span>
          <button className="btn" disabled={!items.length || busy} onClick={downloadActive}>
            현재 다운로드
          </button>
          <button className="btn primary" disabled={!items.length || busy} onClick={downloadAllZip}>
            전체 ZIP 다운로드
          </button>
        </div>
      </div>

      <div className="content-grid-3" style={{ flex: 1, minHeight: 0 }}>
        {/* LEFT: thumbnails */}
        <div className="panel">
          <h3>업로드 이미지 ({items.length}/{MAX_IMAGES})</h3>
          {items.length === 0 ? (
            <DropZone
              accept="image/*"
              multiple
              onFiles={onUpload}
              label="이미지 업로드"
              hint="권장 512×1031 · 초과 시 너비 512 기준 자동 리사이즈"
            />
          ) : (
            <>
              <div className="thumb-list">
                {items.map((it) => (
                  <div
                    key={it.id}
                    className={'thumb' + (it.id === activeId ? ' active' : '')}
                    onClick={() => setActiveId(it.id)}
                  >
                    <div className="pic">
                      <img src={it.fittedCanvas.toDataURL()} alt="" />
                    </div>
                    <div className="meta">
                      <b>{it.name}</b>
                      <small>
                        {it.originalW}×{it.originalH}
                        {(it.originalW !== SCREEN_W) && ` → ${SCREEN_W}×${it.fittedCanvas.height}`}
                      </small>
                      <small style={{ color: it.ocrDone ? 'var(--success)' : 'var(--text-muted)' }}>
                        {it.ocrDone ? `텍스트 ${it.textLayers.length}개` : 'OCR 미실행'}
                      </small>
                    </div>
                    <button
                      className="x"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeItem(it.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {items.length < MAX_IMAGES && (
                <div style={{ marginTop: 10 }}>
                  <DropZone
                    accept="image/*"
                    multiple
                    onFiles={onUpload}
                    label="＋ 이미지 추가"
                    hint={`${MAX_IMAGES - items.length}장 더 추가 가능`}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* CENTER: canvas preview */}
        <div className="canvas-panel">
          <div className="canvas-toolbar">
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {active ? active.name : '이미지를 업로드하세요'}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn sm"
                disabled={!active || busy}
                onClick={runOcr}
              >
                {busy && ocrProgress > 0 ? `OCR ${ocrProgress}%` : 'OCR 텍스트 인식'}
              </button>
            </div>
          </div>
          <div className="canvas-area">
            {active ? (
              <PreviewArea
                item={active}
                frameMode={frameMode}
                customFrame={customFrame}
                onLayerMove={(lid, dx, dy) => {
                  const l = active.textLayers.find((x) => x.id === lid);
                  if (l) updateLayer(lid, { x: l.x + dx, y: l.y + dy });
                }}
              />
            ) : (
              <div className="empty-hero">
                <div className="big">📱</div>
                <h2>이미지를 업로드해 시작하세요</h2>
                <p>업로드된 이미지는 너비 512 기준으로 자동 리사이즈되어 아이폰 프레임 안에 배치됩니다.</p>
              </div>
            )}
          </div>
          {busy && ocrProgress > 0 && (
            <div style={{ padding: '0 16px 12px' }}>
              <div className="progress"><div style={{ width: `${ocrProgress}%` }} /></div>
            </div>
          )}
        </div>

        {/* RIGHT: text layers */}
        <div className="panel">
          <h3>인식된 텍스트 ({active?.textLayers.length || 0})</h3>
          {!active ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>이미지를 선택해 주세요.</p>
          ) : active.textLayers.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              상단의 'OCR 텍스트 인식'을 눌러 이미지에서 텍스트를 추출하세요.<br />
              인식된 텍스트는 동일한 폰트·사이즈로 수정할 수 있습니다.
            </p>
          ) : (
            active.textLayers.map((l) => (
              <div key={l.id} className="text-layer-card">
                <div className="form-row">
                  <label>텍스트</label>
                  <input
                    value={l.text}
                    onChange={(e) => updateLayer(l.id, { text: e.target.value })}
                  />
                </div>
                <div className="form-row inline">
                  <div>
                    <label>폰트</label>
                    <select
                      value={l.fontName}
                      onChange={(e) => {
                        const opt = FONT_OPTIONS.find((f) => f.name === e.target.value);
                        if (opt) updateLayer(l.id, { fontName: opt.name, fontFamily: opt.family, fontWeight: opt.weight });
                      }}
                    >
                      {FONT_OPTIONS.map((f) => (
                        <option key={f.name} value={f.name}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label>사이즈</label>
                    <input
                      type="number"
                      value={l.fontSize}
                      onChange={(e) => updateLayer(l.id, { fontSize: +e.target.value })}
                    />
                  </div>
                </div>
                <div className="form-row inline">
                  <div>
                    <label>색상</label>
                    <input
                      type="color"
                      value={rgbStrToHex(l.color)}
                      onChange={(e) => updateLayer(l.id, { color: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>배경</label>
                    <input
                      type="color"
                      value={rgbStrToHex(l.bgColor || '#ffffff')}
                      onChange={(e) => updateLayer(l.id, { bgColor: e.target.value })}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => updateLayer(l.id, { visible: !l.visible })}>
                    {l.visible ? '숨김' : '표시'}
                  </button>
                  <button className="btn sm danger" onClick={() => deleteLayer(l.id)}>
                    삭제
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ---- Helpers ----

const FONT_OPTIONS = [
  { name: 'SF Pro', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 400 },
  { name: 'SF Pro Bold', family: '-apple-system, BlinkMacSystemFont, sans-serif', weight: 700 },
  { name: 'Pretendard', family: 'Pretendard, sans-serif', weight: 500 },
  { name: 'Pretendard Bold', family: 'Pretendard, sans-serif', weight: 700 },
  { name: 'Noto Sans KR', family: '"Noto Sans KR", sans-serif', weight: 400 },
  { name: 'Noto Sans KR Bold', family: '"Noto Sans KR", sans-serif', weight: 700 },
  { name: 'Helvetica', family: 'Helvetica, Arial, sans-serif', weight: 400 },
  { name: 'Helvetica Bold', family: 'Helvetica, Arial, sans-serif', weight: 700 },
  { name: 'Times New Roman', family: '"Times New Roman", serif', weight: 400 },
  { name: 'Courier New', family: '"Courier New", monospace', weight: 400 },
];

function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function detectTransparentRect(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const a = data[(y * w + x) * 4 + 3];
      if (a < 30) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }
  if (!found) {
    return { x: Math.round(w * 0.05), y: Math.round(h * 0.05), w: Math.round(w * 0.9), h: Math.round(h * 0.9) };
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function sampleBg(canvas, bbox) {
  // Sample a few pixels just above the bbox.
  const ctx = canvas.getContext('2d');
  const y = Math.max(0, bbox.y0 - 4);
  const x = Math.max(0, Math.floor((bbox.x0 + bbox.x1) / 2));
  try {
    const p = ctx.getImageData(x, y, 1, 1).data;
    return `rgb(${p[0]},${p[1]},${p[2]})`;
  } catch {
    return '#ffffff';
  }
}

function sampleFg(canvas, bbox) {
  const ctx = canvas.getContext('2d');
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  if (w < 2 || h < 2) return '#111111';
  try {
    const data = ctx.getImageData(bbox.x0, bbox.y0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 128) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (!n) return '#111111';
    return `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  } catch {
    return '#111111';
  }
}

function rgbStrToHex(s) {
  if (!s) return '#000000';
  if (s.startsWith('#')) return s;
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return '#000000';
  return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
}

// ---- Subcomponents ----

function FrameUploadButton({ onUpload, active }) {
  const ref = useRef(null);
  return (
    <>
      <button
        className={'btn sm ' + (active ? 'primary' : '')}
        style={active ? {} : { background: 'transparent', border: 'none' }}
        onClick={() => ref.current?.click()}
      >
        PNG 프레임 업로드
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/png"
        onChange={(e) => onUpload([...e.target.files])}
      />
    </>
  );
}

function PreviewArea({ item, frameMode, customFrame }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    drawPreview(ref.current, item, frameMode, customFrame);
  }, [item, frameMode, customFrame]);

  const previewScale = 0.55; // display scale only
  const w = (frameMode === 'svg' ? FRAME_W : customFrame?.canvas.width || FRAME_W) * previewScale;
  const h = (frameMode === 'svg' ? FRAME_H : customFrame?.canvas.height || FRAME_H) * previewScale;

  return (
    <canvas
      ref={ref}
      width={frameMode === 'svg' ? FRAME_W : customFrame?.canvas.width || FRAME_W}
      height={frameMode === 'svg' ? FRAME_H : customFrame?.canvas.height || FRAME_H}
      style={{
        width: w,
        height: h,
        filter: 'drop-shadow(0 12px 32px rgba(0,0,0,0.18))',
      }}
    />
  );
}

async function drawPreview(canvas, item, frameMode, customFrame) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Build screen
  const screen = document.createElement('canvas');
  screen.width = SCREEN_W;
  screen.height = SCREEN_H;
  const sctx = screen.getContext('2d');
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  const ih = item.fittedCanvas.height;
  if (ih <= SCREEN_H) sctx.drawImage(item.fittedCanvas, 0, 0);
  else sctx.drawImage(item.fittedCanvas, 0, 0, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
  item.textLayers.filter((l) => l.visible).forEach((l) => {
    sctx.fillStyle = l.bgColor || '#ffffff';
    sctx.fillRect(l.x - 1, l.y - 1, l.w + 2, l.h + 2);
    sctx.fillStyle = l.color || '#111111';
    sctx.font = `${l.fontWeight || 400} ${l.fontSize || 14}px ${l.fontFamily}`;
    sctx.textBaseline = 'top';
    sctx.fillText(l.text, l.x, l.y);
  });

  if (frameMode === 'svg') {
    const svgEl = document.getElementById('iphone-frame-svg-template');
    if (svgEl) {
      const xml = new XMLSerializer().serializeToString(svgEl);
      const svgBlob = new Blob([xml], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      const fimg = await loadImage(url);
      URL.revokeObjectURL(url);
      ctx.drawImage(fimg, 0, 0, FRAME_W, FRAME_H);
    }
    ctx.save();
    roundedRectPath(ctx, SCREEN_X, SCREEN_Y, SCREEN_W, SCREEN_H, 36);
    ctx.clip();
    ctx.drawImage(screen, SCREEN_X, SCREEN_Y);
    ctx.restore();
    ctx.fillStyle = '#000';
    roundedRectPath(ctx, FRAME_W / 2 - 60, SCREEN_Y + 12, 120, 34, 17);
    ctx.fill();
  } else if (customFrame) {
    const { x, y, w, h } = customFrame.screenRect;
    ctx.drawImage(screen, 0, 0, SCREEN_W, SCREEN_H, x, y, w, h);
    ctx.drawImage(customFrame.canvas, 0, 0);
  }
}
