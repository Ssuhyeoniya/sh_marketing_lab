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
  BEZEL,
} from './IphoneFrame';
import { downloadBlob } from '../../utils/pdf';
import { useFontsReady } from '../../utils/fonts';

const MAX_IMAGES = 20;

export default function IphoneMockup() {
  const [frameMode, setFrameMode] = useState('svg'); // 'svg' | 'png'
  const [customFrame, setCustomFrame] = useState(null); // { canvas, screenRect }
  const [items, setItems] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [showRectEditor, setShowRectEditor] = useState(false);
  const [aspectLocked, setAspectLocked] = useState(true);
  const fontsTick = useFontsReady();

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
    const rect = detectTransparentRect(ctx, canvas.width, canvas.height);
    const anchors = detectFrameAnchors(canvas);
    setCustomFrame({ canvas, screenRect: rect, anchors });
    setFrameMode('png');
    setShowRectEditor(true);
    showToast('프레임 업로드 완료. 화면 영역을 확인·조정하세요.');
  };

  const updateScreenRect = (patch) => {
    if (!customFrame) return;
    setCustomFrame({ ...customFrame, screenRect: { ...customFrame.screenRect, ...patch } });
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
      .filter((w) => {
        if (!w.text || !w.text.trim()) return false;
        if (w.confidence < 60) return false;
        const t = w.text.trim();
        if (t.length < 2) return false;
        if (!/[a-zA-Z0-9가-힣]/.test(t)) return false;
        const bw = w.bbox.x1 - w.bbox.x0;
        const bh = w.bbox.y1 - w.bbox.y0;
        if (bw < 6 || bh < 6) return false;
        if (bh > bw * 3 || bw > bh * 25) return false;
        return true;
      })
      .map((w) => {
        const guess = guessFont(w, active.fittedCanvas);
        const bg = sampleBg(active.fittedCanvas, w.bbox);
        const fg = sampleFg(active.fittedCanvas, w.bbox, bg);
        return {
          id: crypto.randomUUID(),
          text: w.text,
          originalText: w.text,
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
          edited: false,
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
          : {
              ...x,
              textLayers: x.textLayers.map((l) => {
                if (l.id !== lid) return l;
                const next = { ...l, ...patch };
                if (patch.text !== undefined && patch.text !== l.originalText) next.edited = true;
                return next;
              }),
            }
      )
    );
  };
  const toggleEdited = (lid) => {
    setItems((it) =>
      it.map((x) =>
        x.id !== active.id
          ? x
          : { ...x, textLayers: x.textLayers.map((l) => (l.id === lid ? { ...l, edited: !l.edited } : l)) }
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
    // Screen canvas is sized to the full fitted image (no cropping).
    const screen = buildScreenCanvas(item);
    const screenH = screen.height;

    if (frameMode === 'svg') {
      // Frame stretches vertically to fit — long screenshots become valid "scroll mockups".
      const frameH = screenH + BEZEL * 2;
      const frameW = FRAME_W;
      const out = document.createElement('canvas');
      out.width = frameW;
      out.height = frameH;
      const octx = out.getContext('2d');
      const url = URL.createObjectURL(new Blob([makeIphoneFrameSvg(frameW, frameH)], { type: 'image/svg+xml' }));
      const fimg = await loadImage(url);
      URL.revokeObjectURL(url);
      octx.drawImage(fimg, 0, 0, frameW, frameH);
      octx.save();
      roundedRectPath(octx, BEZEL, BEZEL, SCREEN_W, screenH, 36);
      octx.clip();
      octx.drawImage(screen, BEZEL, BEZEL);
      octx.restore();
      octx.fillStyle = '#000';
      roundedRectPath(octx, frameW / 2 - 60, BEZEL + 12, 120, 34, 17);
      octx.fill();
      return out;
    } else if (customFrame) {
      const out = document.createElement('canvas');
      out.width = customFrame.canvas.width;
      out.height = customFrame.canvas.height;
      const octx = out.getContext('2d');
      // Fit full image inside user rect, preserving aspect — letterbox with white if needed.
      const { x, y, w, h } = customFrame.screenRect;
      octx.fillStyle = '#ffffff';
      octx.fillRect(x, y, w, h);
      const fit = fitRect(SCREEN_W, screenH, w, h);
      octx.drawImage(screen, x + fit.x, y + fit.y, fit.w, fit.h);
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

      {frameMode === 'png' && customFrame && showRectEditor && (
        <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 12 }}>이미지 영역</b>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>핸들 드래그로 조절 · Shift = 비율 잠금 반전</span>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            W
            <input
              type="number"
              value={Math.round(customFrame.screenRect.w)}
              onChange={(e) => {
                const nw = Math.max(20, +e.target.value);
                if (aspectLocked) {
                  const ratio = customFrame.screenRect.h / customFrame.screenRect.w;
                  updateScreenRect({ w: nw, h: Math.max(20, Math.round(nw * ratio)) });
                } else {
                  updateScreenRect({ w: nw });
                }
              }}
              style={{ width: 70, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4 }}
            />
          </label>
          <button
            className="btn sm"
            onClick={() => setAspectLocked((v) => !v)}
            title="가로·세로 비율 잠금"
            style={{
              padding: '4px 8px',
              background: aspectLocked ? 'var(--primary)' : '#fff',
              color: aspectLocked ? '#fff' : 'var(--text)',
              borderColor: aspectLocked ? 'var(--primary)' : 'var(--border)',
              fontSize: 11,
            }}
          >
            {aspectLocked ? '🔒 비율' : '🔓 자유'}
          </button>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
            H
            <input
              type="number"
              value={Math.round(customFrame.screenRect.h)}
              onChange={(e) => {
                const nh = Math.max(20, +e.target.value);
                if (aspectLocked) {
                  const ratio = customFrame.screenRect.w / customFrame.screenRect.h;
                  updateScreenRect({ h: nh, w: Math.max(20, Math.round(nh * ratio)) });
                } else {
                  updateScreenRect({ h: nh });
                }
              }}
              style={{ width: 70, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 4 }}
            />
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            프레임 {customFrame.canvas.width}×{customFrame.canvas.height} · 가이드 {(customFrame.anchors?.xs.length || 0) + (customFrame.anchors?.ys.length || 0)}개
          </span>
          <button
            className="btn sm"
            onClick={() => {
              const r = detectTransparentRect(customFrame.canvas.getContext('2d'), customFrame.canvas.width, customFrame.canvas.height);
              updateScreenRect(r);
            }}
          >
            자동 재감지
          </button>
        </div>
      )}

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
                key={`prev-${fontsTick}`}
                item={active}
                frameMode={frameMode}
                customFrame={customFrame}
                aspectLocked={aspectLocked}
                onScreenRectChange={(r) => updateScreenRect(r)}
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
            <>
              <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10, padding: '8px 10px', background: '#f0f7ff', borderRadius: 6 }}>
                💡 텍스트를 <b>수정한 항목만</b> 원본 위에 다시 그려집니다. 아이콘·이미지·도형은 그대로 유지됩니다.
              </p>
              {active.textLayers.map((l) => (
              <div key={l.id} className="text-layer-card" style={l.edited ? { borderColor: 'var(--primary)', background: '#eff6ff' } : {}}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 10.5, color: l.edited ? 'var(--primary)' : 'var(--text-muted)' }}>
                  <span>{l.edited ? '● 편집됨 (오버레이 적용)' : '○ 원본 유지'}</span>
                </div>
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
                  <button className="btn sm" onClick={() => toggleEdited(l.id)}>
                    {l.edited ? '원본으로' : '활성화'}
                  </button>
                  <button className="btn sm danger" onClick={() => deleteLayer(l.id)}>
                    삭제
                  </button>
                </div>
              </div>
              ))}
            </>
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
  // 1) Try: bounding box of INTERIOR transparent pixels (not edges).
  //    For PNG mockups where the screen area is cut transparent.
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  const margin = Math.min(20, Math.floor(Math.min(w, h) * 0.05));
  for (let y = margin; y < h - margin; y += 2) {
    for (let x = margin; x < w - margin; x += 2) {
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
  if (found && maxX - minX > w * 0.2 && maxY - minY > h * 0.2) {
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  // 2) Fallback: centered rect with iPhone aspect ratio (512:1031 ≈ 1:2.01).
  const aspect = 1031 / 512;
  let screenH = Math.round(h * 0.86);
  let screenW = Math.round(screenH / aspect);
  if (screenW > w * 0.86) {
    screenW = Math.round(w * 0.86);
    screenH = Math.round(screenW * aspect);
  }
  return {
    x: Math.round((w - screenW) / 2),
    y: Math.round((h - screenH) / 2),
    w: screenW,
    h: screenH,
  };
}

// Sample background from several pixels OUTSIDE the bbox; pick the most extreme luminance
// (background tends to be far from text — either much lighter or much darker).
function sampleBg(canvas, bbox) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const bw = bbox.x1 - bbox.x0, bh = bbox.y1 - bbox.y0;
  const margin = Math.max(6, Math.round(bh * 0.6));
  const positions = [
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y0 - margin],
    [Math.round((bbox.x0 + bbox.x1) / 2), bbox.y1 + margin],
    [bbox.x0 - margin, Math.round((bbox.y0 + bbox.y1) / 2)],
    [bbox.x1 + margin, Math.round((bbox.y0 + bbox.y1) / 2)],
    [bbox.x0 - margin, bbox.y0 - margin],
    [bbox.x1 + margin, bbox.y1 + margin],
  ];
  const samples = [];
  for (const [x, y] of positions) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    try {
      const p = ctx.getImageData(x, y, 1, 1).data;
      samples.push([p[0], p[1], p[2]]);
    } catch {}
  }
  if (!samples.length) return '#ffffff';
  // Compute median of each channel — robust to outlier samples that hit text or another object.
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const r = median(samples.map((s) => s[0]));
  const g = median(samples.map((s) => s[1]));
  const b = median(samples.map((s) => s[2]));
  return `rgb(${r},${g},${b})`;
}

// Sample foreground: pick pixels in bbox with highest contrast from the sampled background.
function sampleFg(canvas, bbox, bgRgb) {
  const ctx = canvas.getContext('2d');
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  if (w < 2 || h < 2) return '#111111';
  const bg = parseRgb(bgRgb) || [255, 255, 255];
  const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  try {
    const data = ctx.getImageData(bbox.x0, bbox.y0, w, h).data;
    // Determine direction (darker text on light bg, or lighter text on dark bg)
    const darkerExpected = bgLum > 128;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const diff = darkerExpected ? bgLum - lum : lum - bgLum;
      if (diff > 50) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (!n) return darkerExpected ? '#111111' : '#ffffff';
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

function PreviewArea({ item, frameMode, customFrame, aspectLocked, onScreenRectChange }) {
  const ref = useRef(null);
  const wrapRef = useRef(null);
  const [scale, setScale] = useState(0.55);

  // Frame intrinsic dimensions — SVG stretches per item to fit long screenshots.
  const screenH = item ? item.fittedCanvas.height : SCREEN_H;
  const frameW = frameMode === 'svg' ? FRAME_W : customFrame?.canvas.width || FRAME_W;
  const frameH = frameMode === 'svg' ? screenH + BEZEL * 2 : customFrame?.canvas.height || FRAME_H;

  // Observe the canvas-area container; recompute scale to fit available space.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const host = wrap.parentElement; // .canvas-area
    if (!host) return;
    const update = () => {
      const cs = getComputedStyle(host);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const availW = Math.max(120, host.clientWidth - padX);
      const availH = Math.max(120, host.clientHeight - padY);
      const sw = availW / frameW;
      const sh = availH / frameH;
      // Use whichever is more restrictive, but cap at 1.0 (don't upscale beyond native)
      const s = Math.max(0.1, Math.min(sw, sh, 1.0));
      setScale(s);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [frameW, frameH]);

  useEffect(() => {
    if (!ref.current) return;
    drawPreview(ref.current, item, frameMode, customFrame);
  }, [item, frameMode, customFrame]);

  const dispW = frameW * scale;
  const dispH = frameH * scale;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <canvas
        ref={ref}
        width={frameW}
        height={frameH}
        style={{
          width: dispW,
          height: dispH,
          display: 'block',
          filter: 'drop-shadow(0 12px 32px rgba(0,0,0,0.18))',
        }}
      />
      {frameMode === 'png' && customFrame && onScreenRectChange && (
        <ResizeOverlay
          rect={customFrame.screenRect}
          frameW={frameW}
          frameH={frameH}
          scale={scale}
          aspectLocked={aspectLocked}
          anchors={customFrame.anchors}
          onChange={onScreenRectChange}
        />
      )}
    </div>
  );
}

const SNAP_THRESHOLD = 6; // pixels in frame coords

function ResizeOverlay({ rect, frameW, frameH, scale, aspectLocked, anchors, onChange }) {
  const [drag, setDrag] = useState(null);
  const [guides, setGuides] = useState({ x: [], y: [] });

  // Effective snap targets = frame edges + frame center + detected anchors
  const xTargets = [0, frameW / 2, frameW, ...(anchors?.xs || [])];
  const yTargets = [0, frameH / 2, frameH, ...(anchors?.ys || [])];

  const begin = (handle) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag({ handle, sx: e.clientX, sy: e.clientY, orig: { ...rect }, shift: e.shiftKey });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      const dx = (e.clientX - drag.sx) / scale;
      const dy = (e.clientY - drag.sy) / scale;
      const H = drag.handle;
      // Shift toggles aspect lock
      const effLock = e.shiftKey ? !aspectLocked : aspectLocked;
      let { x, y, w, h } = drag.orig;
      const aspect = drag.orig.w / drag.orig.h;

      if (H === 'move') {
        x += dx; y += dy;
      } else if (effLock && ['nw', 'ne', 'sw', 'se'].includes(H)) {
        // Corner with aspect lock: drive by dx, derive dy
        let dwSign = H.includes('e') ? 1 : -1;
        let nw = drag.orig.w + dwSign * dx;
        if (nw < 20) nw = 20;
        let nh = nw / aspect;
        if (H.includes('w')) x = drag.orig.x + (drag.orig.w - nw);
        if (H.includes('n')) y = drag.orig.y + (drag.orig.h - nh);
        w = nw; h = nh;
      } else if (effLock && ['n', 's'].includes(H)) {
        // Vertical edge with aspect lock — center-anchored horizontally
        let nh = H === 's' ? drag.orig.h + dy : drag.orig.h - dy;
        if (nh < 20) nh = 20;
        let nw = nh * aspect;
        x = drag.orig.x + (drag.orig.w - nw) / 2;
        if (H === 'n') y = drag.orig.y + (drag.orig.h - nh);
        w = nw; h = nh;
      } else if (effLock && ['e', 'w'].includes(H)) {
        let nw = H === 'e' ? drag.orig.w + dx : drag.orig.w - dx;
        if (nw < 20) nw = 20;
        let nh = nw / aspect;
        y = drag.orig.y + (drag.orig.h - nh) / 2;
        if (H === 'w') x = drag.orig.x + (drag.orig.w - nw);
        w = nw; h = nh;
      } else {
        // Free resize
        if (H.includes('n')) { y += dy; h -= dy; }
        if (H.includes('s')) { h += dy; }
        if (H.includes('w')) { x += dx; w -= dx; }
        if (H.includes('e')) { w += dx; }
      }

      // Min size guard
      if (w < 20) { if (H.includes('w')) x = drag.orig.x + drag.orig.w - 20; w = 20; }
      if (h < 20) { if (H.includes('n')) y = drag.orig.y + drag.orig.h - 20; h = 20; }

      // Snap to anchors
      const activeGuides = { x: [], y: [] };
      const snap = computeSnap(H, { x, y, w, h }, xTargets, yTargets, SNAP_THRESHOLD);
      x = snap.x; y = snap.y; w = snap.w; h = snap.h;
      activeGuides.x = snap.guideX;
      activeGuides.y = snap.guideY;

      // Clamp to frame
      x = Math.max(0, Math.min(x, frameW - w));
      y = Math.max(0, Math.min(y, frameH - h));
      w = Math.min(w, frameW - x);
      h = Math.min(h, frameH - y);

      setGuides(activeGuides);
      onChange({ x, y, w, h });
    };
    const onUp = () => {
      setDrag(null);
      setGuides({ x: [], y: [] });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, scale, frameW, frameH, aspectLocked, anchors, onChange]);

  const rx = rect.x * scale, ry = rect.y * scale;
  const rw = rect.w * scale, rh = rect.h * scale;

  const handles = [
    { id: 'nw', x: rx, y: ry, cur: 'nwse-resize' },
    { id: 'n', x: rx + rw / 2, y: ry, cur: 'ns-resize' },
    { id: 'ne', x: rx + rw, y: ry, cur: 'nesw-resize' },
    { id: 'w', x: rx, y: ry + rh / 2, cur: 'ew-resize' },
    { id: 'e', x: rx + rw, y: ry + rh / 2, cur: 'ew-resize' },
    { id: 'sw', x: rx, y: ry + rh, cur: 'nesw-resize' },
    { id: 's', x: rx + rw / 2, y: ry + rh, cur: 'ns-resize' },
    { id: 'se', x: rx + rw, y: ry + rh, cur: 'nwse-resize' },
  ];

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Snap guide lines */}
      {guides.x.map((gx, i) => (
        <div key={'gx' + i} style={{
          position: 'absolute', left: gx * scale - 0.5, top: 0,
          width: 1, height: frameH * scale,
          background: '#ef4444', pointerEvents: 'none',
        }} />
      ))}
      {guides.y.map((gy, i) => (
        <div key={'gy' + i} style={{
          position: 'absolute', left: 0, top: gy * scale - 0.5,
          width: frameW * scale, height: 1,
          background: '#ef4444', pointerEvents: 'none',
        }} />
      ))}
      {/* Movable body */}
      <div
        onMouseDown={begin('move')}
        title="드래그로 이동 · Shift=비율 반전"
        style={{
          position: 'absolute',
          left: rx, top: ry, width: rw, height: rh,
          cursor: drag?.handle === 'move' ? 'grabbing' : 'move',
          pointerEvents: 'auto',
          border: '2px dashed #3b82f6',
          boxSizing: 'border-box',
          background: 'rgba(59,130,246,0.04)',
        }}
      />
      {/* Size label */}
      {drag && (
        <div style={{
          position: 'absolute',
          left: rx + rw / 2, top: ry + rh + 6,
          transform: 'translateX(-50%)',
          background: '#1f2937', color: '#fff',
          padding: '3px 8px', borderRadius: 4,
          fontSize: 11, pointerEvents: 'none',
          fontFamily: 'monospace',
        }}>
          {Math.round(rect.w)} × {Math.round(rect.h)}
        </div>
      )}
      {/* Handles */}
      {handles.map((h) => (
        <div
          key={h.id}
          onMouseDown={begin(h.id)}
          style={{
            position: 'absolute',
            left: h.x - 6, top: h.y - 6,
            width: 12, height: 12,
            background: '#fff',
            border: '2px solid #3b82f6',
            borderRadius: 2,
            cursor: h.cur,
            pointerEvents: 'auto',
            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        />
      ))}
    </div>
  );
}

// Apply snap-to-target. Adjusts the rect's moving edge/position by up to SNAP_THRESHOLD.
// Returns adjusted rect + which guide lines fired.
function computeSnap(handle, r, xTargets, yTargets, thr) {
  const out = { ...r, guideX: [], guideY: [] };
  // Determine which edges/centers are "active" for this drag.
  let activeXs, activeYs;
  if (handle === 'move') {
    activeXs = [['left', r.x], ['centerX', r.x + r.w / 2], ['right', r.x + r.w]];
    activeYs = [['top', r.y], ['centerY', r.y + r.h / 2], ['bottom', r.y + r.h]];
  } else {
    activeXs = [];
    activeYs = [];
    if (handle.includes('w')) activeXs.push(['left', r.x]);
    if (handle.includes('e')) activeXs.push(['right', r.x + r.w]);
    if (handle.includes('n')) activeYs.push(['top', r.y]);
    if (handle.includes('s')) activeYs.push(['bottom', r.y + r.h]);
  }
  // X snap
  for (const [edge, val] of activeXs) {
    let best = null;
    for (const t of xTargets) {
      const d = Math.abs(val - t);
      if (d < thr && (!best || d < best.d)) best = { d, t };
    }
    if (best) {
      const delta = best.t - val;
      if (handle === 'move' || edge === 'left' || edge === 'centerX') {
        if (edge === 'left' || handle === 'move') out.x += delta;
        else if (edge === 'centerX') out.x += delta;
      }
      if (edge === 'right' && handle !== 'move') out.w += delta;
      else if (edge === 'left' && handle !== 'move') { out.x += delta; out.w -= delta; }
      out.guideX.push(best.t);
    }
  }
  // Y snap
  for (const [edge, val] of activeYs) {
    let best = null;
    for (const t of yTargets) {
      const d = Math.abs(val - t);
      if (d < thr && (!best || d < best.d)) best = { d, t };
    }
    if (best) {
      const delta = best.t - val;
      if (handle === 'move' || edge === 'top' || edge === 'centerY') {
        if (edge === 'top' || handle === 'move') out.y += delta;
        else if (edge === 'centerY') out.y += delta;
      }
      if (edge === 'bottom' && handle !== 'move') out.h += delta;
      else if (edge === 'top' && handle !== 'move') { out.y += delta; out.h -= delta; }
      out.guideY.push(best.t);
    }
  }
  return out;
}

// Detect strong horizontal/vertical edges in a canvas — used as smart-guide anchor targets.
function detectFrameAnchors(canvas) {
  const w = canvas.width, h = canvas.height;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 300));
  const sw = Math.max(2, Math.floor(w / step));
  const sh = Math.max(2, Math.floor(h / step));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const ctx = small.getContext('2d');
  ctx.drawImage(canvas, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const lum = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

  // Per-row horizontal-edge strength (sum of |luminance diff with row above|)
  const yScores = new Float32Array(sh);
  for (let y = 1; y < sh; y++) {
    let s = 0;
    for (let x = 0; x < sw; x++) {
      s += Math.abs(lum(((y) * sw + x) * 4) - lum(((y - 1) * sw + x) * 4));
    }
    yScores[y] = s / sw;
  }
  const xScores = new Float32Array(sw);
  for (let x = 1; x < sw; x++) {
    let s = 0;
    for (let y = 0; y < sh; y++) {
      s += Math.abs(lum((y * sw + x) * 4) - lum((y * sw + (x - 1)) * 4));
    }
    xScores[x] = s / sh;
  }
  // Pick peaks above mean*2.5
  const peaks = (arr) => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const thr = mean * 2.5;
    const out = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] > thr && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) out.push(i);
    }
    return out;
  };
  const cluster = (vals, gap) => {
    if (!vals.length) return [];
    vals = [...vals].sort((a, b) => a - b);
    const out = [];
    let group = [vals[0]];
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] - group[group.length - 1] < gap) group.push(vals[i]);
      else {
        out.push(Math.round(group.reduce((a, b) => a + b, 0) / group.length));
        group = [vals[i]];
      }
    }
    out.push(Math.round(group.reduce((a, b) => a + b, 0) / group.length));
    return out;
  };
  const ys = cluster(peaks(yScores).map((v) => v * step), Math.max(8, step * 4));
  const xs = cluster(peaks(xScores).map((v) => v * step), Math.max(8, step * 4));
  // Cap to top 30 each to avoid clutter
  return { xs: xs.slice(0, 30), ys: ys.slice(0, 30) };
}

async function drawPreview(canvas, item, frameMode, customFrame) {
  const ctx = canvas.getContext('2d');
  const screen = buildScreenCanvas(item);
  const screenH = screen.height;

  if (frameMode === 'svg') {
    const frameH = screenH + BEZEL * 2;
    const frameW = FRAME_W;
    canvas.width = frameW;
    canvas.height = frameH;
    ctx.clearRect(0, 0, frameW, frameH);
    const url = URL.createObjectURL(new Blob([makeIphoneFrameSvg(frameW, frameH)], { type: 'image/svg+xml' }));
    const fimg = await loadImage(url);
    URL.revokeObjectURL(url);
    ctx.drawImage(fimg, 0, 0, frameW, frameH);
    ctx.save();
    roundedRectPath(ctx, BEZEL, BEZEL, SCREEN_W, screenH, 36);
    ctx.clip();
    ctx.drawImage(screen, BEZEL, BEZEL);
    ctx.restore();
    ctx.fillStyle = '#000';
    roundedRectPath(ctx, frameW / 2 - 60, BEZEL + 12, 120, 34, 17);
    ctx.fill();
  } else if (customFrame) {
    canvas.width = customFrame.canvas.width;
    canvas.height = customFrame.canvas.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { x, y, w, h } = customFrame.screenRect;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    const fit = fitRect(SCREEN_W, screenH, w, h);
    ctx.drawImage(screen, x + fit.x, y + fit.y, fit.w, fit.h);
    ctx.drawImage(customFrame.canvas, 0, 0);
  }
}

// Returns canvas SCREEN_W × fittedCanvas.height with image + edited text overlays.
function buildScreenCanvas(item) {
  const c = document.createElement('canvas');
  c.width = SCREEN_W;
  c.height = item.fittedCanvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(item.fittedCanvas, 0, 0);
  item.textLayers
    .filter((l) => l.visible && l.edited)
    .forEach((l) => drawTextOverlay(ctx, l));
  return c;
}

// Robust text-overlay draw — clears the union of original bbox and new-text bbox.
function drawTextOverlay(ctx, l) {
  ctx.font = `${l.fontWeight || 400} ${l.fontSize || 14}px ${l.fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(l.text || ' ');
  const fontSize = l.fontSize || 14;
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.9;
  const descent = m.actualBoundingBoxDescent || fontSize * 0.3;
  const newW = m.width;
  // Anchor to ORIGINAL baseline so line position stays where it was.
  const baseY = l.y + l.h;
  const newTop = baseY - ascent;
  const newBottom = baseY + descent;
  // Clear area = union of (original bbox) and (new-text bbox), with padding.
  const PAD = 3;
  const clearLeft = l.x - PAD;
  const clearRight = Math.max(l.x + l.w, l.x + newW) + PAD;
  const clearTop = Math.min(l.y, newTop) - PAD;
  const clearBottom = Math.max(l.y + l.h, newBottom) + PAD;
  ctx.fillStyle = l.bgColor || '#ffffff';
  ctx.fillRect(clearLeft, clearTop, clearRight - clearLeft, clearBottom - clearTop);
  ctx.fillStyle = ensureContrast(l.color || '#111111', l.bgColor || '#ffffff');
  ctx.fillText(l.text || '', l.x, baseY);
}

function ensureContrast(fg, bg) {
  const a = parseRgb(fg), b = parseRgb(bg);
  if (!a || !b) return fg;
  const la = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
  const lb = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
  if (Math.abs(la - lb) < 40) return lb > 128 ? '#111111' : '#ffffff';
  return fg;
}
function parseRgb(s) {
  if (!s) return null;
  if (s.startsWith('#')) {
    const v = s.slice(1);
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return [r, g, b];
  }
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// Fit src (sw, sh) inside dst (dw, dh), preserving aspect. Returns {x, y, w, h} inside dst.
function fitRect(sw, sh, dw, dh) {
  const sa = sw / sh, da = dw / dh;
  if (sa > da) {
    const w = dw, h = w / sa;
    return { x: 0, y: (dh - h) / 2, w, h };
  } else {
    const h = dh, w = h * sa;
    return { x: (dw - w) / 2, y: 0, w, h };
  }
}

function makeIphoneFrameSvg(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3a3d44" />
      <stop offset="0.5" stop-color="#1f2126" />
      <stop offset="1" stop-color="#2c2f36" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" rx="48" ry="48" fill="url(#g1)" />
  <rect x="${BEZEL - 2}" y="${BEZEL - 2}" width="${w - BEZEL * 2 + 4}" height="${h - BEZEL * 2 + 4}" rx="38" ry="38" fill="#0a0a0a" />
  <rect x="-2" y="160" width="4" height="40" fill="#15171b" rx="1" />
  <rect x="-2" y="240" width="4" height="68" fill="#15171b" rx="1" />
  <rect x="-2" y="328" width="4" height="68" fill="#15171b" rx="1" />
  <rect x="${w - 2}" y="220" width="4" height="100" fill="#15171b" rx="1" />
</svg>`;
}
