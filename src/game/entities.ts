import { Rng } from '../core/rng.js';
import {
  BOMB_SLIDE_STEP,
  IFRAMES,
  PIERCE_UNLOCK_POWER,
  MAX_SHIELD,
  MAX_SPEED,
  PUSH_TIME_MULT,
  START_BOMBS,
  START_POWER,
  STEP_TIME,
  STEP_TIME_MIN,
} from './constants.js';
import { Cell, PickupKind } from './types.js';
import type { World } from './world.js';

/** Anything that walks the grid one tile at a time with smooth interpolation. */
export abstract class Walker {
  gx: number;
  gy: number;
  fromX: number;
  fromY: number;
  /** 0..1 progress through the current step. */
  t = 1;
  facing = { x: 0, y: 1 };
  stepDur = STEP_TIME;
  alive = true;

  constructor(x: number, y: number) {
    this.gx = x;
    this.gy = y;
    this.fromX = x;
    this.fromY = y;
  }

  get moving(): boolean {
    return this.t < 1;
  }

  /** Interpolated position in tile space, for rendering. */
  get rx(): number {
    if (this.t >= 1) return this.gx;
    return this.fromX + (this.gx - this.fromX) * this.t;
  }

  get ry(): number {
    if (this.t >= 1) return this.gy;
    return this.fromY + (this.gy - this.fromY) * this.t;
  }

  get vx(): number {
    return this.rx;
  }

  get vy(): number {
    return this.ry;
  }

  advance(dt: number): void {
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.stepDur);
    }
  }

  beginStep(dx: number, dy: number, dur: number): void {
    this.fromX = this.gx;
    this.fromY = this.gy;
    this.gx += dx;
    this.gy += dy;
    this.facing = { x: dx, y: dy };
    this.stepDur = dur;
    this.t = 0;
  }

  reverseStep(): void {
    const oldFromX = this.fromX;
    const oldFromY = this.fromY;
    this.fromX = this.gx;
    this.fromY = this.gy;
    this.gx = oldFromX;
    this.gy = oldFromY;
    this.facing = { x: -this.facing.x, y: -this.facing.y };
    this.t = Math.max(0, 1 - this.t);
  }
}

export class Player extends Walker {
  readonly index: number;
  chassis = 'standard';
  bombs = START_BOMBS;
  power = START_POWER;
  speed = 0;
  shield = 0;
  live = 0;
  iframes = 0;
  score = 0;
  down = false;
  pushTimeMult = PUSH_TIME_MULT;
  /** Temporary global Push Drive modifier, maintained by Game. */
  pushBoost = 1;
  bombFuse = 2.1;
  /** Once true, walking into a live bomb shoves it instead of blocking. */
  kick = false;
  /** Kick tier 2: the shoved bomb keeps sliding until something stops it. */
  slide = false;
  /** Blasts from this player's bombs tunnel through Soft blocks. */
  pierce = false;
  magnet = false;
  lift = false;
  /** Rising Void proximity, 0..1, drives the panic vignette. */
  danger = 0;
  /** A direction pressed mid-step, replayed the moment this step lands. */
  bufferDx = 0;
  bufferDy = 0;
  bufferAge = 0;
  /** Last frame's held direction, for detecting a fresh press. */
  lastDx = 0;
  lastDy = 0;
  /** Counts down while a direction is held; movement repeats once it hits 0. */
  dasTimer = 0;

  constructor(index: number, x: number, y: number) {
    super(x, y);
    this.index = index;
  }

  get baseStep(): number {
    return Math.max(STEP_TIME_MIN, STEP_TIME - this.speed * 0.012);
  }

  collect(kind: number): string {
    switch (kind) {
      case PickupKind.FIRE:
        this.power++;
        return 'BLAST+';
      case PickupKind.BOMB:
        this.bombs++;
        return 'BOMB+';
      case PickupKind.SPEED:
        this.speed = Math.min(MAX_SPEED, this.speed + 1);
        return 'RUSH+';
      case PickupKind.KICK:
        this.kick = true;
        return 'KICK+';
      case PickupKind.SLIDE:
        // Slide implies kick, so picking it up first is never a dead grab.
        this.kick = true;
        this.slide = true;
        return 'KICK SLIDE!';
      case PickupKind.MAGNET:
        this.magnet = true;
        return 'MAGNET: FACE SHARD + ACTION';
      case PickupKind.LIFT:
        this.kick = this.slide = this.lift = true;
        return 'LIFT: TAP TO GRAB / THROW';
      case PickupKind.PIERCE:
        this.pierce = true;
        return 'PIERCE!';
      default:
        this.shield = Math.min(MAX_SHIELD, this.shield + 1);
        return 'SHIELD+';
    }
  }

  /**
   * False for anything this player already owns or has maxed out. The drop
   * table asks before it rolls, so a run stops burying Soft blocks with
   * powerups that would land as a no-op.
   */
  canUse(kind: number): boolean {
    switch (kind) {
      case PickupKind.FIRE:
      case PickupKind.BOMB: return true;
      case PickupKind.MAGNET: return !this.magnet;
      case PickupKind.LIFT: return this.slide && !this.lift;
      case PickupKind.SPEED: return this.speed < MAX_SPEED;
      case PickupKind.SHIELD: return this.shield < MAX_SHIELD;
      case PickupKind.KICK: return !this.kick;
      // Upgrades enter the pool after their prerequisite tool or blast threshold.
      case PickupKind.SLIDE: return this.kick && !this.slide;
      case PickupKind.PIERCE: return this.power >= PIERCE_UNLOCK_POWER && !this.pierce;
      default: return true;
    }
  }

  hurt(): boolean {
    if (this.iframes > 0 || this.down) return false;
    if (this.shield > 0) {
      this.shield--;
      this.iframes = IFRAMES;
      return false;
    }
    this.down = true;
    this.t = 1;
    return true;
  }
}

export interface Bomb {
  x: number;
  y: number;
  fuse: number;
  power: number;
  owner: number;
  /** Set once a chain reaction has claimed it, so it only detonates once. */
  spent: boolean;
  tickTimer?: number;
  carriedBy?: number;
  /** A thrown bomb reserves its landing tile while visually arcing from its origin. */
  flight?: { fromX: number; fromY: number; remaining: number };
  /** Blast tunnels through Soft blocks. Captured from the owner at drop time. */
  pierce?: boolean;
  /** Slide direction while a Kick Slide is carrying it; 0 when at rest. */
  sx?: number;
  sy?: number;
  /** Seconds left before the slide commits its next tile. */
  slideT?: number;
  /** Render-only offset in tiles, advanced at the kick travel speed. */
  ox?: number;
  oy?: number;
  /** Previous simulation tick's visual position, for render interpolation. */
  previousX?: number;
  previousY?: number;
  /** Presentation-only duration of a one-tile kick. */
  kickSeconds?: number;
}

export interface Flame {
  owner?: number;
  blastId?: number;
  x: number;
  y: number;
  life: number;
  max: number;
  /** 0 centre, 1 arm, 2 tip — used to pick the sprite. */
  kind: number;
  dx: number;
  dy: number;
  /** True only for the tile where this flame just destroyed a Soft block or hit a Shard — stays impassable while it burns. */
  breaking?: boolean;
}

export class Enemy extends Walker {
  readonly hitBlasts = new Set<number | Flame>();
  hp = 1;
  maxHp = 1;
  stun = 0;
  panic = 0;
  fleeing = false;
  wander = 0;
  readonly variant: number;

  constructor(x: number, y: number, variant: number) {
    super(x, y);
    this.variant = variant;
    // 0: Drifter (base), 1: Hunter (fast/tracker), 2: Glitcher (speed/bomb-flee), 3: Warden (armored 2HP)
    if (variant === 1) {
      this.stepDur = 0.30;
      this.hp = 1;
    } else if (variant === 2) {
      this.stepDur = 0.28;
      this.hp = 1;
    } else if (variant === 3) {
      this.stepDur = 0.44;
      this.hp = 2;
    } else {
      this.stepDur = 0.38;
      this.hp = 1;
    }
    this.maxHp = this.hp;
  }

  update(dt: number, world: World, rng: Rng, targets: Player[], bombs: Bomb[], flames: Flame[]): void {
    if (this.stun > 0) {
      this.stun -= dt;
      return;
    }

    // Variant 2: Glitcher Panic reaction setup (Phase 1 of 3-phase animation)
    if (this.variant === 2 && bombs.length > 0) {
      const nearBomb = bombs.find((b) => Math.abs(b.x - this.gx) + Math.abs(b.y - this.gy) <= 2);
      if (nearBomb) {
        if (!this.fleeing && this.panic <= 0) {
          // Setup: 0.25s panic hesitation & telegraph before sprinting
          this.panic = 0.25;
          this.fleeing = true;
        }
      } else {
        this.fleeing = false;
      }
    } else if (this.variant === 2) {
      this.fleeing = false;
    }

    if (this.panic > 0) {
      this.panic = Math.max(0, this.panic - dt);
      return; // Shiver in place during telegraph window
    }

    this.advance(dt);
    if (this.moving) return;

    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    const canEnter = (x: number, y: number) => {
      return (
        world.isWalkable(x, y) &&
        !bombs.some((b) => b.x === x && b.y === y) &&
        !flames.some((f) => f.x === x && f.y === y)
      );
    };

    const validDirs = dirs.filter(([dx, dy]) => canEnter(this.gx + dx, this.gy + dy));
    if (validDirs.length === 0) {
      this.facing = { x: 0, y: 0 };
      return;
    }

    // Variant 2: Glitcher - Flee from nearby active bombs (Phase 2: Fast execution sprint)
    if (this.variant === 2 && bombs.length > 0) {
      const nearBomb = bombs.find((b) => Math.abs(b.x - this.gx) + Math.abs(b.y - this.gy) <= 2);
      if (nearBomb) {
        // Prioritize escape directions that don't collide with live players
        const safeDirs = validDirs.filter(
          ([dx, dy]) => !targets.some((p) => !p.down && p.gx === this.gx + dx && p.gy === this.gy + dy),
        );
        const candidates = safeDirs.length > 0 ? safeDirs : validDirs;

        let bestDist = -1;
        let fleeDir = candidates[0];
        for (const [dx, dy] of candidates) {
          const dist = Math.abs(this.gx + dx - nearBomb.x) + Math.abs(this.gy + dy - nearBomb.y);
          if (dist > bestDist) {
            bestDist = dist;
            fleeDir = [dx, dy];
          }
        }
        this.facing = { x: fleeDir[0], y: fleeDir[1] };
        this.beginStep(this.facing.x, this.facing.y, 0.18);
        return;
      }
    }

    // Variant 1: Hunter - Home in on nearest live target (leash of 5 tiles)
    if (this.variant === 1 && targets && targets.length > 0) {
      const live = targets.filter((p) => !p.down);
      if (live.length > 0) {
        let nearest = live[0];
        let minDist = Math.abs(nearest.gx - this.gx) + Math.abs(nearest.gy - this.gy);
        for (let i = 1; i < live.length; i++) {
          const d = Math.abs(live[i].gx - this.gx) + Math.abs(live[i].gy - this.gy);
          if (d < minDist) {
            minDist = d;
            nearest = live[i];
          }
        }

        // 20% chance per step to lose the scent instead of tracking perfectly,
        // so it reads as a persistent guard rather than a psychic chaser.
        if (minDist <= 5 && rng.chance(0.8)) {
          const dx = nearest.gx - this.gx;
          const dy = nearest.gy - this.gy;
          const wanted: Array<[number, number]> = [];
          if (Math.abs(dx) >= Math.abs(dy)) {
            if (dx !== 0) wanted.push([dx > 0 ? 1 : -1, 0]);
            if (dy !== 0) wanted.push([0, dy > 0 ? 1 : -1]);
          } else {
            if (dy !== 0) wanted.push([0, dy > 0 ? 1 : -1]);
            if (dx !== 0) wanted.push([dx > 0 ? 1 : -1, 0]);
          }

          const match = wanted.find(([wx, wy]) => canEnter(this.gx + wx, this.gy + wy));
          if (match) {
            this.facing = { x: match[0], y: match[1] };
            this.beginStep(this.facing.x, this.facing.y, this.stepDur);
            return;
          }
        }
      }
    }

    // Default / Drifter / Warden / Glitcher ambient patrol: maintain straight direction or pick alternative on block
    const frontX = this.gx + this.facing.x;
    const frontY = this.gy + this.facing.y;
    const blocked = !canEnter(frontX, frontY) || (this.facing.x === 0 && this.facing.y === 0);

    let nextDir = this.facing;
    if (blocked) {
      const forwardOnly = validDirs.filter(([dx, dy]) => dx !== -this.facing.x || dy !== -this.facing.y);
      const chosen = rng.pick(forwardOnly.length > 0 ? forwardOnly : validDirs);
      nextDir = { x: chosen[0], y: chosen[1] };
    }

    this.facing = nextDir;
    if (this.facing.x !== 0 || this.facing.y !== 0) {
      this.beginStep(this.facing.x, this.facing.y, this.stepDur);
    }
  }
}

/** Attempt one player step. Handles Sokoban pushes and pickup pickup. */
export function stepPlayer(
  p: Player,
  dx: number,
  dy: number,
  world: World,
  bombs: Bomb[],
  players: Player[],
  flames: Flame[],
): 'blocked' | 'moved' | 'pushed' {
  const nx = p.gx + dx;
  const ny = p.gy + dy;

  const bombThere = bombs.find((b) => !b.spent && b.carriedBy === undefined && b.x === nx && b.y === ny);
  if (bombThere) {
    if (!p.kick || bombThere.flight) return 'blocked';
    const kx = nx + dx;
    const ky = ny + dy;
    const kickBlocked =
      !world.isWalkable(kx, ky) ||
      bombs.some((b) => b !== bombThere && b.x === kx && b.y === ky) ||
      flames.some((f) => f.x === kx && f.y === ky) ||
      players.some((pl) => !pl.down && pl.gx === kx && pl.gy === ky);
    if (kickBlocked) return 'blocked';
    bombThere.x = kx;
    bombThere.y = ky;
    // Preserve the displayed position if a moving bomb is kicked again.
    bombThere.ox = (bombThere.ox ?? 0) - dx;
    bombThere.oy = (bombThere.oy ?? 0) - dy;
    bombThere.kickSeconds = p.slide ? BOMB_SLIDE_STEP : 0.11;
    if (p.slide) {
      // The first tile is committed here, exactly as a plain kick does, so the
      // player always gets the tile they stepped into. Game.updateBombs keeps
      // feeding it tiles until something blocks the lane.
      bombThere.sx = dx;
      bombThere.sy = dy;
      bombThere.slideT = BOMB_SLIDE_STEP;
    }
    p.beginStep(dx, dy, p.baseStep);
    return 'moved';
  }

  const breakingFlameThere = flames.some((f) => f.x === nx && f.y === ny && f.breaking);
  if (breakingFlameThere) return 'blocked';

  const t = world.typeAt(nx, ny);

  // A sealed Gate row still accepts Shards, so test the seal only for bodies.
  if (t !== Cell.SHARD && world.isSealed(ny)) return 'blocked';

  if (t === Cell.SHARD) {
    const piece = world.pieceAt(nx, ny);
    if (!piece) return 'blocked';
    // A shard cannot be shoved into an active grounded bomb, or the puzzle could bury one.
    const wouldHitBomb = piece.cells.some((c) =>
      bombs.some((b) => !b.spent && b.carriedBy === undefined && b.x === c.x + dx && b.y === c.y + dy),
    );
    if (wouldHitBomb || !world.movePiece(piece, dx, dy, players, p)) return 'blocked';
    p.beginStep(dx, dy, p.baseStep * (p.pushTimeMult || PUSH_TIME_MULT) * p.pushBoost);
    return 'pushed';
  }

  if (t !== Cell.EMPTY && t !== Cell.PICKUP) return 'blocked';

  p.beginStep(dx, dy, p.baseStep);
  return 'moved';
}

