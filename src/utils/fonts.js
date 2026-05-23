import { useEffect, useState } from 'react';

// Preload key fonts (so canvas can use them) and notify when ready.
// Preload every weight we let users pick — required so canvas can render in
// those weights without falling back to a generic sans (which would shift
// Korean glyph widths and break the OCR-edit layout).
const TARGET_FONTS = [
  // Korean sans
  '300 16px Pretendard', '400 16px Pretendard', '500 16px Pretendard',
  '600 16px Pretendard', '700 16px Pretendard', '800 16px Pretendard',
  '400 16px SUIT', '500 16px SUIT', '700 16px SUIT',
  '300 16px "Noto Sans KR"', '400 16px "Noto Sans KR"', '500 16px "Noto Sans KR"',
  '700 16px "Noto Sans KR"', '900 16px "Noto Sans KR"',
  '400 16px "Nanum Gothic"', '700 16px "Nanum Gothic"',
  '400 16px "IBM Plex Sans KR"', '700 16px "IBM Plex Sans KR"',
  '400 16px "Gothic A1"', '700 16px "Gothic A1"',
  '400 16px "Gowun Dodum"',
  '700 16px "Black Han Sans"',
  '400 16px "Do Hyeon"',
  '400 16px "Jua"',
  // Korean serif
  '400 16px "Noto Serif KR"', '700 16px "Noto Serif KR"',
  '400 16px "Nanum Myeongjo"', '700 16px "Nanum Myeongjo"',
  // Latin
  '400 16px Inter', '500 16px Inter', '700 16px Inter',
  '400 16px Roboto', '500 16px Roboto', '700 16px Roboto',
  '400 16px "IBM Plex Sans"', '700 16px "IBM Plex Sans"',
  '400 16px "IBM Plex Serif"', '700 16px "IBM Plex Serif"',
  '400 16px "IBM Plex Mono"',
  '400 16px "Source Sans 3"',
  '400 16px Lato', '700 16px Lato',
  '400 16px "Open Sans"',
  '400 16px Montserrat',
  '400 16px Poppins',
  '400 16px Merriweather',
  '400 16px "JetBrains Mono"',
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
