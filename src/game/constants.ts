/** Playfield width in tiles, including the two indestructible border columns. */
export const COLS = 13;
/** Interior playable columns are 1 .. COLS-2. */
export const INNER_LEFT = 1;
export const INNER_RIGHT = COLS - 2;
export const INNER_WIDTH = INNER_RIGHT - INNER_LEFT + 1;

/** How many tile-rows the camera shows. Tuned so a bomb blast fits with room. */
export const VIEW_ROWS = 17;

/** Seconds to walk one tile at base speed. */
export const STEP_TIME = 0.125;
/**
 * Delayed auto-shift. A tap moves exactly one tile; the direction must then be
 * held this long before movement repeats. Without it a normal ~200ms keypress
 * spends two steps, and "step off the bomb onto the corner" overshoots.
 */
export const DAS_DELAY = 0.24;
/** How long a direction pressed mid-step is remembered and replayed on arrival. */
export const INPUT_BUFFER = 0.14;
/**
 * A perpendicular press only cuts the corner once the current step is this far
 * along. Earlier turns wait until the tile is reached, so facing a block does
 * not pop you around it.
 */
export const CORNER_CUT_AT = 0.82;
export const STEP_TIME_MIN = 0.072;
/** Seconds a Sokoban push takes; deliberately slower than a free step. */
export const PUSH_TIME_MULT = 1.55;

export const BOMB_FUSE = 2.1;
export const FLAME_TIME = 0.42;
export const BLAST_PUSH = 3;

export const START_BOMBS = 1;
export const START_POWER = 2;
/** Blast power required to unlock Pierce; bomb count and power have no cap. */
export const PIERCE_UNLOCK_POWER = 7;
export const BOMB_THROW_RANGE = 4;
export const BOMB_THROW_SECONDS = 0.32;
export const MAX_SPEED = 5;
export const MAX_SHIELD = 2;
/** Seconds a kicked bomb spends crossing one tile while it slides. */
export const BOMB_SLIDE_STEP = 0.055;

/** Void rise speed in rows/second, before pressure and depth scaling. */
export const VOID_BASE_SPEED = 0.30;
/** The Void refuses to fall further behind than this many rows. */
export const VOID_MAX_LAG = VIEW_ROWS - 2;
/** Minimum rise speed outside temporary freezes. */
export const VOID_MIN_SPEED = 0.11;
/**
 * Permanent speed the Void gains per Gate opened, as a fraction of base. The
 * release of the gate brake is already a ~3x jump; this only has to keep a
 * long run from flattening out, so it stays small enough that sector 20 is a
 * 20% tax rather than a wall.
 */
export const VOID_CHAPTER_RAMP = 0.01;

export const VOID_ROLLBACK_ROWS = 4;
export const VOID_FREEZE_SECONDS = 5;
export const PUSH_DRIVE_SECONDS = 10;
export const PUSH_DRIVE_MULT = 0.55;
/** Four cleared lines reliably earn a panic-saving Combo Surge. */
export const COMBO_BATTERY_PER_LINE = 25;

/** Rows of Bomberman arena between Gates, and how the band thickens by depth. */
export const ARENA_ROWS = 15;
export const GATE_SPACER = 2;

export const SOFT_BLOCK_CHANCE = 0.46;
export const PICKUP_CHANCE = 0.19;

export const IFRAMES = 1.6;
export const REVIVE_TIME = 6.0;

export type ModeId = 'solo' | 'coop' | 'versus' | 'daily' | 'tutorial';
