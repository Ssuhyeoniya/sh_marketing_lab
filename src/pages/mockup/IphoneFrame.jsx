// Built-in iPhone 15 Pro -style SVG frame.
// Screen area: 512 x 1031 (the canonical inserted-image size).
// Frame total: 548 x 1067 (bezel 18 each side).
export const SCREEN_W = 512;
export const SCREEN_H = 1031;
export const BEZEL = 18;
export const FRAME_W = SCREEN_W + BEZEL * 2; // 548
export const FRAME_H = SCREEN_H + BEZEL * 2; // 1067
export const SCREEN_X = BEZEL;
export const SCREEN_Y = BEZEL;
export const RADIUS = 48;
export const SCREEN_RADIUS = 36;

export function IPhoneFrameSvg({ children, scale = 1 }) {
  const w = FRAME_W * scale;
  const h = FRAME_H * scale;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${FRAME_W} ${FRAME_H}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="frameGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a3d44" />
          <stop offset="0.5" stopColor="#1f2126" />
          <stop offset="1" stopColor="#2c2f36" />
        </linearGradient>
        <clipPath id="screenClip">
          <rect
            x={SCREEN_X}
            y={SCREEN_Y}
            width={SCREEN_W}
            height={SCREEN_H}
            rx={SCREEN_RADIUS}
            ry={SCREEN_RADIUS}
          />
        </clipPath>
      </defs>
      {/* Outer body */}
      <rect
        x="0"
        y="0"
        width={FRAME_W}
        height={FRAME_H}
        rx={RADIUS}
        ry={RADIUS}
        fill="url(#frameGrad)"
      />
      {/* Inner bezel */}
      <rect
        x={SCREEN_X - 2}
        y={SCREEN_Y - 2}
        width={SCREEN_W + 4}
        height={SCREEN_H + 4}
        rx={SCREEN_RADIUS + 2}
        ry={SCREEN_RADIUS + 2}
        fill="#0a0a0a"
      />
      {/* Side buttons */}
      <rect x="-2" y="160" width="4" height="40" fill="#15171b" rx="1" />
      <rect x="-2" y="240" width="4" height="68" fill="#15171b" rx="1" />
      <rect x="-2" y="328" width="4" height="68" fill="#15171b" rx="1" />
      <rect x={FRAME_W - 2} y="220" width="4" height="100" fill="#15171b" rx="1" />
      {/* Screen content (provided via foreignObject so we can put a canvas/img inside) */}
      <g clipPath="url(#screenClip)">{children}</g>
      {/* Dynamic island */}
      <rect
        x={FRAME_W / 2 - 60}
        y={SCREEN_Y + 12}
        width="120"
        height="34"
        rx="17"
        fill="#000"
      />
    </svg>
  );
}
