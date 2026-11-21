export const Cell = {
  EMPTY: 0,
  /** Indestructible pillar / border. */
  SOLID: 1,
  /** Destructible brick. Drops pickups. */
  SOFT: 2,
  /** Part of a pushable polyomino Shard. `meta` holds the piece id. */
  SHARD: 3,
  /** Gate wall. Immune to blasts; only a completed line removes it. */
  GATE: 4,
  /** Walkable pickup. `meta` holds the PickupKind. */
  PICKUP: 5,
  /** Reactor core set into a Gate wall. Blast fire destroys it. */
  CORE: 6,
} as const;
export type CellType = (typeof Cell)[keyof typeof Cell];

export const PickupKind = {
  FIRE: 0,
  BOMB: 1,
  SPEED: 2,
  SHIELD: 3,
  /** Walking into a live bomb shoves it one tile instead of blocking you. */
  KICK: 4,
  /** Pushes the Void back immediately. */
  ROLLBACK: 5,
  /** Stops the Void briefly. */
  FREEZE: 6,
  /** Makes every push much faster for a short window. */
  DRIVE: 7,
  /** Kick tier 2: a kicked bomb slides until something stops it. */
  SLIDE: 8,
  /** Blasts eat straight through Soft blocks instead of stopping at the first. */
  PIERCE: 9,
  /** Pull a shard across a one-tile gap. */
  MAGNET: 10,
  /** Kick tier 3: carry and throw live bombs. */
  LIFT: 11,
} as const;
export type PickupKindT = (typeof PickupKind)[keyof typeof PickupKind];

export interface Piece {
  id: number;
  /** Absolute tile coordinates of every cell still belonging to this shard. */
  cells: Array<{ x: number; y: number }>;
  /** Palette index, so a shard reads as the same object as it slides. */
  hue: number;
  /** Set once the shard has been locked into a completed gate row. */
  locked: boolean;
  /** Render-only slide offset in tiles, decayed each frame. */
  ox: number;
  oy: number;
}

export interface GateSocket {
  startX: number;
  width: number;
  shapeName: string;
  cells: Array<[number, number]>;
}

export interface GateRow {
  y: number;
  cleared: boolean;
  /** Tile x positions that started empty — the slots to fill. */
  slots: number[];
  /** Exact 2D shape blueprint sockets for this gate row. */
  sockets?: GateSocket[];
  /** Core Gate: tile x positions of the reactor cores in this row. */
  cores?: number[];
}

export interface Segment {
  kind: 'arena' | 'gate';
  y0: number;
  y1: number;
  index: number;
  rows?: GateRow[];
  /** All gate rows cleared: the way up is open. */
  open?: boolean;
  /** Milestone Boss Gate (Sectors 5, 10, etc.) */
  isBoss?: boolean;
}
