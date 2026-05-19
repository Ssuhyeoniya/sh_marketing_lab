import { useEffect, useState } from 'react';

// Preload key fonts (so canvas can use them) and notify when ready.
// Preload every weight we let users pick — required so canvas can render in those weights.
const TARGET_FONTS = [
  '300 16px Pretendard',
  '400 16px Pretendard',
  '500 16px Pretendard',
  '600 16px Pretendard',
  '700 16px Pretendard',
  '800 16px Pretendard',
  '400 16px "Noto Sans KR"',
  '500 16px "Noto Sans KR"',
  '700 16px "Noto Sans KR"',
  '900 16px "Noto Sans KR"',
];

let readyPromise = null;
function ensureFonts() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all(TARGET_FONTS.map((f) => document.fonts.load(f)));
      await document.fonts.ready;
    } catch {}
  })();
  return readyPromise;
}

// Returns an incrementing counter that increments once fonts are loaded.
// Components can include this in their render-effect deps to redraw the canvas.
export function useFontsReady() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    ensureFonts().then(() => setTick((v) => v + 1));
  }, []);
  return tick;
}
