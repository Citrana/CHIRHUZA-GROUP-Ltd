import type { CelebrationTier } from "@/lib/sale-celebration";

/**
 * The sale mascot: a pixel-art shopping-bag buddy holding the day's gift
 * above its head. Drawn from small pixel grids in the brand colours; the
 * motion (hop, wave, blink, gift pop) lives in globals.css (`mascot-*`).
 */

const COLOURS: Record<string, string> = {
  P: "var(--primary)",
  A: "var(--accent)",
  C: "var(--chart-3)",
};

// 16 x 16: handle, body, eyes, smile, base band, legs.
const BODY = [
  "....PPPPPPPP....",
  "...P........P...",
  "...P........P...",
  ".PPPPPPPPPPPPPP.",
  ".PAAAAAAAAAAAAP.",
  ".PAAAAAAAAAAAAP.",
  ".PAAAAAAAAAAAAP.",
  ".PAAAAAAAAAAAAP.",
  ".PAAAAAAAAAAAAP.",
  ".PAAAPAAAAPAAAP.",
  ".PAAAAPPPPAAAAP.",
  ".PAAAAAAAAAAAAP.",
  ".PCCCCCCCCCCCCP.",
  ".PPPPPPPPPPPPPP.",
  "....PP....PP....",
  "....PP....PP....",
];
const EYES = [
  [4, 6],
  [5, 6],
  [4, 7],
  [5, 7],
  [10, 6],
  [11, 6],
  [10, 7],
  [11, 7],
];
const LEFT_ARM = [
  [0, 7],
  [0, 8],
  [0, 9],
];
const RIGHT_ARM_DOWN = [
  [15, 7],
  [15, 8],
  [15, 9],
];
const RIGHT_ARM_UP = [
  [15, 4],
  [15, 5],
  [15, 6],
];

// 10 x 10 gifts, one per tier.
const GIFTS: Record<CelebrationTier, string[]> = {
  seedling: [
    "PPP....PPP",
    "PAAP..PAAP",
    "PAAAPPAAAP",
    ".PAAPPAAP.",
    "..PPPPPP..",
    "....PP....",
    "....PP....",
    "....PP....",
    "..CCCCCC..",
    ".CCCCCCCC.",
  ],
  star: [
    "....PP....",
    "....PP....",
    "...PAAP...",
    "PPPPAAPPPP",
    "PAAAAAAAAP",
    ".PAAAAAAP.",
    "..PAAAAP..",
    "..PAAAAP..",
    ".PAAPPAAP.",
    ".PPP..PPP.",
  ],
  trophy: [
    "PPPPPPPPPP",
    "PAAAAAAAAP",
    "PAAAAAAAAP",
    ".PAAAAAAP.",
    ".PAAAAAAP.",
    "..PAAAAP..",
    "...PPPP...",
    "....PP....",
    "..PCCCCP..",
    "..PPPPPP..",
  ],
  crown: [
    "..........",
    "P...PP...P",
    "PP..PP..PP",
    "PAP.PP.PAP",
    "PAAPAAPAAP",
    "PAAAAAAAAP",
    "PACAACAACP",
    "PAAAAAAAAP",
    "PPPPPPPPPP",
    "..........",
  ],
};

const SPARKLES = [
  [1, 2],
  [15, 1],
  [0, 8],
  [15, 8],
];

function Grid({ rows, x = 0, y = 0 }: { rows: string[]; x?: number; y?: number }) {
  return rows.flatMap((row, dy) =>
    [...row].flatMap((c, dx) =>
      COLOURS[c] ? [<rect key={`${dx}-${dy}`} x={x + dx} y={y + dy} width={1} height={1} fill={COLOURS[c]} />] : [],
    ),
  );
}

function Pixels({ points, fill, y = 0 }: { points: number[][]; fill: string; y?: number }) {
  return points.map(([x, py]) => <rect key={`${x}-${py}`} x={x} y={y + py} width={1} height={1} fill={fill} />);
}

/** 18 x 28 pixels: gift (rows 0-9), gap, buddy (rows 12-27). */
export function PixelMascot({ tier, className }: { tier: CelebrationTier; className?: string }) {
  return (
    <svg viewBox="-1 0 18 28" shapeRendering="crispEdges" className={className} aria-hidden>
      <g className="mascot-gift">
        <Grid rows={GIFTS[tier]} x={3} />
      </g>
      <g className="mascot-sparkles">
        <Pixels points={SPARKLES} fill="var(--chart-3)" />
      </g>
      <g transform="translate(0 12)">
        <Grid rows={BODY} />
        <g className="mascot-eyes">
          <Pixels points={EYES} fill="var(--primary)" />
        </g>
        <Pixels points={LEFT_ARM} fill="var(--primary)" />
        <g className="mascot-arm-down">
          <Pixels points={RIGHT_ARM_DOWN} fill="var(--primary)" />
        </g>
        <g className="mascot-arm-up">
          <Pixels points={RIGHT_ARM_UP} fill="var(--primary)" />
        </g>
      </g>
    </svg>
  );
}
