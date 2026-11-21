/**
 * BOMBAZ colour system.
 *
 * Two rules keep it readable on a phone and on a 65" TV:
 *  - Everything the player must react to is a saturated key colour on the
 *    near-black ground. Everything else is desaturated indigo.
 *  - Nothing is distinguished by hue alone. Shards also differ in their inner
 *    glyph, pickups in their icon, players in their silhouette ring.
 */
export const PAL = {
  void: '#07030f',
  voidEdge: '#1a0530',
  deep: '#120a24',
  grid: '#1d1040',
  /* Hard blocks are cool steel and recede. Soft blocks are warm rose and
     advertise themselves as targets. Never the same hue family. */
  solid: '#1c2a55',
  solidTop: '#38508f',
  solidEdge: '#6382d6',
  soft: '#7a1f4e',
  softTop: '#c23a7a',
  softEdge: '#ff7ab8',
  gate: '#170e33',
  gateEdge: '#9b5cff',
  ink: '#fff6ff',
  magenta: '#ff2d95',
  cyan: '#21e6ff',
  lime: '#b4ff39',
  amber: '#ffb020',
  orange: '#ff6a2a',
  violet: '#9b5cff',
} as const;

/** Player identity: silhouette ring + trail. P1 lime, P2 cyan. */
export const PLAYER_COLORS = [PAL.lime, PAL.cyan];
export const PLAYER_DARK = ['#3f6b0e', '#0d5a70'];

/**
 * Shard palette. Deliberately excludes lime (the runners) and rose (bricks)
 * so a shard is never mistaken for a thing you are or a thing you break.
 * Each hue also carries its own glyph, so hue is never the only signal.
 */
export const SHARD_COLORS = [
  ['#21e6ff', '#0a6d84'],
  ['#ffb020', '#8a5306'],
  ['#9b5cff', '#4a1e94'],
  ['#ff6a2a', '#8a2d09'],
  ['#4d8bff', '#153a8a'],
  ['#f2ecff', '#6b6486'],
] as const;

export interface EraPalette {
  name: string;
  void: string;
  deep: string;
  grid: string;
  solid: string;
  solidTop: string;
  solidEdge: string;
  soft: string;
  softTop: string;
  softEdge: string;
  gate: string;
  gateEdge: string;
  backdropTop: string;
  backdropMid: string;
  backdropBot: string;
}

export const ERA_PALETTES: EraPalette[] = [
  // Era 0: Cartridge 8-Bit (Sectors 1-3)
  {
    name: 'CARTRIDGE 8-BIT',
    void: '#070a06',
    deep: '#0f170d',
    grid: '#1a2816',
    solid: '#21331a',
    solidTop: '#3e6030',
    solidEdge: '#5c8f47',
    soft: '#6e3814',
    softTop: '#b35d22',
    softEdge: '#f08235',
    gate: '#131f10',
    gateEdge: '#a0e843',
    backdropTop: '#182914',
    backdropMid: '#0e180c',
    backdropBot: '#070a06',
  },
  // Era 1: 16-Bit Arcade (Sectors 4-6)
  {
    name: '16-BIT ARCADE',
    void: '#07030f',
    deep: '#120a24',
    grid: '#1d1040',
    solid: '#1c2a55',
    solidTop: '#38508f',
    solidEdge: '#6382d6',
    soft: '#7a1f4e',
    softTop: '#c23a7a',
    softEdge: '#ff7ab8',
    gate: '#170e33',
    gateEdge: '#9b5cff',
    backdropTop: '#150a2e',
    backdropMid: '#0c0520',
    backdropBot: '#07030f',
  },
  // Era 2: Y2K Vapor Terminal (Sectors 7-9)
  {
    name: 'Y2K TERMINAL',
    void: '#050212',
    deep: '#0c0524',
    grid: '#1e0c4a',
    solid: '#1a1848',
    solidTop: '#343088',
    solidEdge: '#5c54d4',
    soft: '#581050',
    softTop: '#982488',
    softEdge: '#db40c4',
    gate: '#120428',
    gateEdge: '#b432ff',
    backdropTop: '#1c0840',
    backdropMid: '#0e0422',
    backdropBot: '#050212',
  },
  // Era 3: Vector Minimalist (Sectors 10+)
  {
    name: 'VECTOR MATRIX',
    void: '#030305',
    deep: '#090a10',
    grid: '#161822',
    solid: '#181b24',
    solidTop: '#32384c',
    solidEdge: '#546080',
    soft: '#401824',
    softTop: '#7a283e',
    softEdge: '#b83c5c',
    gate: '#0c0e14',
    gateEdge: '#21e6ff',
    backdropTop: '#0e1018',
    backdropMid: '#080910',
    backdropBot: '#030305',
  },
];

export function getEraPalette(chapter: number): EraPalette {
  const eraIndex = Math.min(ERA_PALETTES.length - 1, Math.floor(chapter / 3));
  return ERA_PALETTES[eraIndex];
}

export const SHARD_GLYPHS = ['◆', '●', '▲', '■', '✦', '⬢'];

export const FLAME_COLORS = ['#fff6ff', '#ffe36a', '#ffb020', '#ff6a2a', '#ff2d95'];

export const CONFETTI = [PAL.magenta, PAL.cyan, PAL.lime, PAL.amber, PAL.ink, PAL.violet];

