import { Rng } from '../core/rng.js';
import { CONFETTI, FLAME_COLORS, PAL, PLAYER_COLORS } from '../render/palette.js';
import { FxBus } from '../render/fx.js';
import type { Input } from '../input/input.js';
import {
  BOMB_FUSE,
  BOMB_SLIDE_STEP,
  BOMB_THROW_RANGE,
  BOMB_THROW_SECONDS,
  CORNER_CUT_AT,
  DAS_DELAY,
  FLAME_TIME,
  INPUT_BUFFER,
  IFRAMES,
  INNER_LEFT,
  INNER_RIGHT,
  VIEW_ROWS,
  VOID_BASE_SPEED,
  VOID_CHAPTER_RAMP,
  VOID_MAX_LAG,
  VOID_MIN_SPEED,
  COMBO_BATTERY_PER_LINE,
  PUSH_DRIVE_MULT,
  PUSH_DRIVE_SECONDS,
  VOID_FREEZE_SECONDS,
  VOID_ROLLBACK_ROWS,
  type ModeId,
} from './constants.js';
import { Enemy, Player, stepPlayer, type Bomb, type Flame } from './entities.js';
import { Cell, PickupKind, type Piece } from './types.js';
import { World } from './world.js';
import { audio } from '../core/audio.js';
import { applyChassis } from './progression.js';
import { storage, type LeaderboardEntry } from '../core/storage.js';
import { RunRecorder, encodePad, type RunReplay } from '../core/recording.js';

const BOOMS = ['BLAM!', 'KRAK!', 'FWOOM!', 'BADOOM!', 'KA-POW!', 'WHUMP!'];

export interface GameConfig {
  mode: ModeId;
  seed: number;
  chassisId?: string;
  runId?: string;
  date?: string;
  persist?: boolean;
  record?: boolean;
}

export type Phase = 'playing' | 'paused' | 'over';

export class Game {
  readonly mode: ModeId;
  readonly rng: Rng;
  readonly world: World;
  private readonly presentationRng: Rng;
  private nextBlastId = 1;
  readonly runId: string;
  readonly date: string;
  private readonly persist: boolean;
  private finalized = false;
  private scoreSaved = false;
  private readonly recorder: RunRecorder | undefined;
  readonly seed: number;
  readonly fx = new FxBus();

  players: Player[] = [];
  bombs: Bomb[] = [];
  flames: Flame[] = [];
  enemies: Enemy[] = [];

  /** Absolute row the Void has eaten up to (float, pauses at unsolved gates). */
  voidY = -4;
  /** Bottom row of the camera, in absolute rows (float). */
  camY = -1.5;
  camShake = 0;
  pressure = 0;
  time = 0;
  phase: Phase = 'playing';
  outcome = '';
  chapter = 0;
  bestDepth = 0;
  combo = 0;
  comboTimer = 0;
  linesCleared = 0;
  gatesOpened = 0;
  earnedChips = 0;
  tutorialStep = 0;
  tutorialToastTimer = 0;
  /** 0..100; four cleared lines reliably trigger a Void-saving Surge. */
  comboBattery = 0;
  voidFreezeTimer = 0;
  pushDriveTimer = 0;
  /** Preserve the puzzle's push lane until every row of this gate is solved. */

  constructor(cfg: GameConfig) {
    this.seed = cfg.seed;
    this.recorder = cfg.record ? new RunRecorder() : undefined;
    this.runId = cfg.runId ?? String(cfg.seed);
    this.date = cfg.date ?? storage.getTodayDailyKey();
    this.persist = cfg.persist ?? true;
    this.mode = cfg.mode;
    this.rng = new Rng(cfg.seed);
    this.world = new World(new Rng(cfg.seed), new Rng(cfg.seed ^ 0x64726f70));
    this.presentationRng = new Rng(cfg.seed ^ 0x6678);

    if (cfg.mode === 'tutorial') {
      this.voidY = -5;
    }

    const count = cfg.mode === 'solo' || cfg.mode === 'daily' || cfg.mode === 'tutorial' ? 1 : 2;
    const spots = [
      { x: 3, y: 1 },
      { x: INNER_RIGHT - 2, y: 1 },
    ];
    const chassis = cfg.mode === 'daily' ? 'standard' : cfg.chassisId || storage.getSelectedChassis();
    for (let i = 0; i < count; i++) {
      const s = this.world.findOpen(spots[i].x, spots[i].y);
      const p = new Player(i, s.x, s.y);
      applyChassis(p, chassis);
      this.players.push(p);
    }
  }


  // ------------------------------------------------------------- accessors

  get livePlayers(): Player[] {
    return this.players.filter((p) => !p.down);
  }

  get leadY(): number {
    const live = this.livePlayers;
    const pool = live.length ? live : this.players;
    return pool.reduce((m, p) => Math.max(m, p.gy), this.world.base);
  }

  get score(): number {
    return this.players.reduce((s, p) => s + p.score, 0);
  }

  /** 0..1 — how close the Void is to the lead player. Drives the panic FX. */
  get danger(): number {
    return Math.max(0, Math.min(1, 1 - (this.leadY - this.voidY) / 8));
  }

  // ---------------------------------------------------------------- update

  update(dt: number, input: Input): void {
    // Pausing must not advance hit-stop either: recorded gameplay excludes pauses.
    if (this.phase === 'paused') return;
    if (this.phase === 'playing' && this.recorder) {
      this.recorder.append(encodePad(input.read(0)), this.players.length > 1 ? encodePad(input.read(1)) : 0);
    }
    this.fx.update(dt);
    if (this.phase !== 'playing') return;
    if (this.fx.hitStop > 0) return;

    this.time += dt;
    this.pressure += dt * 0.0032;
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer === 0) this.combo = 0;
    this.voidFreezeTimer = Math.max(0, this.voidFreezeTimer - dt);
    this.pushDriveTimer = Math.max(0, this.pushDriveTimer - dt);

    this.world.ensureUpTo(this.leadY + VIEW_ROWS + 8);

    for (const b of this.bombs) {
      b.previousX = b.x + (b.ox ?? 0);
      b.previousY = b.y + (b.oy ?? 0);
    }
    this.updatePlayers(dt, input);
    this.updateBombs(dt);
    this.updateFlames(dt);
    this.updateEnemies(dt);
    this.updateShards(dt);
    this.updateGates();
    this.updateVoid(dt);
    this.updateCamera(dt);
    this.checkEnd();

    audio.setDanger(this.danger);
    this.noteVoidEscape();
  }

  /**
   * Presentation only: a callout when the lead climbs back out of the Void's
   * reach. Uses no sim RNG and writes no sim state, so replays are unaffected.
   */
  private voidScare = false;
  private noteVoidEscape(): void {
    const d = this.danger;
    if (d > 0.85) this.voidScare = true;
    else if (this.voidScare && d < 0.35) {
      this.voidScare = false;
      const lead = this.livePlayers[0];
      if (lead) this.fx.say(lead.gx + 0.5, lead.gy + 1.4, 'ESCAPED!', PAL.lime, 1);
    }
  }

  private updatePlayers(dt: number, input: Input): void {
    for (const p of this.players) {
      if (p.down) continue;

      p.iframes = Math.max(0, p.iframes - dt);

      const wasMoving = p.moving;
      p.advance(dt);
      if (wasMoving && !p.moving) this.onArrive(p);

      const pad = input.read(p.index);
      p.pushBoost = this.pushDriveTimer > 0 ? PUSH_DRIVE_MULT : 1;
      const toolUsed = pad.action && this.useTool(p, pad.dx, pad.dy);
      if (!toolUsed) this.steer(p, pad.dx, pad.dy, dt);

      if (pad.action && !toolUsed) this.placeBomb(p);

      p.danger = Math.max(0, Math.min(1, 1 - (p.gy - this.voidY) / 6));
    }
  }

  private canEnterTile(nx: number, ny: number): boolean {
    const bombThere = this.bombs.some((b) => b.x === nx && b.y === ny);
    if (bombThere) return false;
    const flameThere = this.flames.some((f) => f.x === nx && f.y === ny);
    if (flameThere) return false;
    const t = this.world.typeAt(nx, ny);
    if (t !== Cell.SHARD && this.world.isSealed(ny)) return false;
    if (t === Cell.SHARD) return false;
    return t === Cell.EMPTY || t === Cell.PICKUP;
  }

  /**
   * Grid movement with delayed auto-shift, skilled corner-cutting, and 180° reversals.
   */
  private steer(p: Player, dx: number, dy: number, dt: number): void {
    const fresh = (dx !== 0 || dy !== 0) && (dx !== p.lastDx || dy !== p.lastDy);

    if (fresh) {
      // Remember it even if a step is already in flight, so the next tile is
      // taken the instant this one lands.
      p.bufferDx = dx;
      p.bufferDy = dy;
      p.bufferAge = INPUT_BUFFER;
      p.dasTimer = DAS_DELAY;
    } else if (dx || dy) {
      p.dasTimer = Math.max(0, p.dasTimer - dt);
    } else {
      p.dasTimer = 0;
    }
    p.lastDx = dx;
    p.lastDy = dy;
    p.bufferAge = Math.max(0, p.bufferAge - dt);

    if (p.moving) {
      // 1. Instant 180° mid-step reversal
      if (dx !== 0 || dy !== 0) {
        if (dx === -p.facing.x && dy === -p.facing.y) {
          p.reverseStep();
          p.bufferAge = 0;
          p.bufferDx = 0;
          p.bufferDy = 0;
          audio.playMove();
          return;
        }

        // 2. Late corner-cut into an open perpendicular tile. Earlier turns stay buffered.
        const isPerpendicular = (p.facing.x === 0 && dx !== 0) || (p.facing.y === 0 && dy !== 0);
        if (isPerpendicular && p.t >= CORNER_CUT_AT) {
          if (this.canEnterTile(p.gx + dx, p.gy + dy)) {
            this.onArrive(p);
            p.beginStep(dx, dy, p.baseStep);
            audio.playMove();
            p.bufferAge = 0;
            p.bufferDx = 0;
            p.bufferDy = 0;
            return;
          }
        }
      }
      return;
    }

    let sx = 0;
    let sy = 0;
    if (p.bufferAge > 0 && (p.bufferDx || p.bufferDy)) {
      sx = p.bufferDx;
      sy = p.bufferDy;
    } else if ((dx || dy) && p.dasTimer <= 0) {
      sx = dx;
      sy = dy;
    }
    if (!sx && !sy) return;

    let r = stepPlayer(p, sx, sy, this.world, this.bombs, this.players, this.flames);

    // 3. Corner-slide only after the direction has been held through DAS.
    // A fresh press into a wall faces that wall so you can still aim at it.
    if (r === 'blocked' && !fresh && (sx !== 0 || sy !== 0)) {
      if (sx !== 0 && sy === 0) {
        // Horizontal move blocked: check if North or South corridor is open
        if (this.canEnterTile(p.gx, p.gy + 1) && this.canEnterTile(p.gx + sx, p.gy + 1)) {
          r = stepPlayer(p, 0, 1, this.world, this.bombs, this.players, this.flames);
        } else if (this.canEnterTile(p.gx, p.gy - 1) && this.canEnterTile(p.gx + sx, p.gy - 1)) {
          r = stepPlayer(p, 0, -1, this.world, this.bombs, this.players, this.flames);
        }
      } else if (sy !== 0 && sx === 0) {
        // Vertical move blocked: check if East or West corridor is open
        if (this.canEnterTile(p.gx + 1, p.gy) && this.canEnterTile(p.gx + 1, p.gy + sy)) {
          r = stepPlayer(p, 1, 0, this.world, this.bombs, this.players, this.flames);
        } else if (this.canEnterTile(p.gx - 1, p.gy) && this.canEnterTile(p.gx - 1, p.gy + sy)) {
          r = stepPlayer(p, -1, 0, this.world, this.bombs, this.players, this.flames);
        }
      }
    }

    if (r === 'pushed') {
      this.fx.kick(1.2, 0.6);
      p.score += 2;
      audio.playPush();
      this.checkCrushEnemies();
    } else if (r === 'moved') {
      audio.playMove();
    }
    if (r === 'blocked') {
      // Face the wall you walked into, and stop retrying it every frame.
      p.facing = { x: sx, y: sy };
      p.bufferAge = 0;
      return;
    }
    p.bufferAge = 0;
    p.bufferDx = 0;
    p.bufferDy = 0;
  }

  private onArrive(p: Player): void {
    if (this.world.typeAt(p.gx, p.gy) === Cell.PICKUP) {
      const label = this.collectPickup(p, this.world.metaAt(p.gx, p.gy));
      this.world.set(p.gx, p.gy, Cell.EMPTY);
      p.score += 50;
      // Same comic lettering as a blast callout, nudged in off the side walls.
      const sayX = Math.min(INNER_RIGHT - 1.5, Math.max(INNER_LEFT + 2, p.gx + 0.5));
      this.fx.say(sayX, p.gy + 1.2, label, PLAYER_COLORS[p.index], 1);
      this.fx.burst(p.gx + 0.5, p.gy + 0.5, 10, [PAL.ink, PLAYER_COLORS[p.index]], 4);
      this.fx.kick(1.5, 1.2);
      audio.playPowerup();
    }
    const depth = p.gy;
    if (depth > this.bestDepth) {
      const diff = depth - this.bestDepth;
      p.score += diff * 5;
      if (Math.floor(depth / 10) > Math.floor(this.bestDepth / 10)) {
        this.earnedChips += 1;
      }
      this.bestDepth = depth;
    }
  }

  /**
   * A drop is worth spawning if any runner still standing would gain from it.
   * In co-op that keeps a Kick alive for the partner who hasn't found one yet.
   */
  private anyoneWants(kind: number): boolean {
    const alive = this.players.filter((p) => !p.down);
    return (alive.length ? alive : this.players).some((p) => p.canUse(kind));
  }

  private collectPickup(p: Player, kind: number): string {
    if (kind !== PickupKind.ROLLBACK && kind !== PickupKind.FREEZE && kind !== PickupKind.DRIVE) {
      return p.collect(kind);
    }

    switch (kind) {
      case PickupKind.ROLLBACK:
        this.rollbackVoid(VOID_ROLLBACK_ROWS);
        return 'ROLLBACK!';
      case PickupKind.FREEZE:
        this.voidFreezeTimer = Math.max(this.voidFreezeTimer, VOID_FREEZE_SECONDS);
        return 'VOID FROZEN!';
      case PickupKind.DRIVE:
        this.pushDriveTimer = Math.max(this.pushDriveTimer, PUSH_DRIVE_SECONDS);
        return 'PUSH DRIVE!';
      default:
        return 'POWER UP!';
    }
  }

  private rollbackVoid(rows: number): void {
    this.voidY = Math.max(this.world.base === 0 ? -4 : this.world.base - 1, this.voidY - rows);
  }

  /** Contextual Action keeps keyboard, touch, gamepad and replays on one verb. */
  private useTool(p: Player, dx: number, dy: number): boolean {
    const carried = this.bombs.find((b) => !b.spent && b.carriedBy === p.index);
    if (!p.lift && !p.magnet && !carried) return false;
    if (p.moving) return !!carried;
    if (dx || dy) p.facing = { x: dx, y: dy };
    const { x: fx, y: fy } = p.facing;
    if (carried) {
      // Prefer the full throw; shorten it if that landing is occupied.
      let landing: { x: number; y: number } | undefined;
      for (let distance = 1; distance <= BOMB_THROW_RANGE; distance++) {
        const x = p.gx + fx * distance, y = p.gy + fy * distance;
        if (x < INNER_LEFT || x > INNER_RIGHT || y <= this.voidY || y >= this.world.top) break;
        // Throw over pillars and shards, but never across a sealed puzzle gate.
        if (this.world.isSealed(y) || this.world.typeAt(x, y) === Cell.GATE) break;
        if (this.freeToolTile(x, y, carried)) landing = { x, y };
      }
      if (landing) {
        carried.carriedBy = undefined;
        carried.flight = { fromX: p.gx, fromY: p.gy, remaining: BOMB_THROW_SECONDS };
        carried.x = landing.x;
        carried.y = landing.y;
        this.fx.say(p.gx + 0.5, p.gy + 1, 'THROW!', PAL.amber, 0);
      } else this.fx.say(p.gx + 0.5, p.gy + 1, 'NO LANDING', PAL.amber, 0);
      return true;
    }
    if (p.lift) {
      const bomb = this.bombs.find((b) => !b.spent && b.carriedBy === undefined && !b.flight &&
        ((b.x === p.gx && b.y === p.gy) || (b.x === p.gx + fx && b.y === p.gy + fy)));
      if (bomb) {
        bomb.carriedBy = p.index;
        bomb.x = p.gx; bomb.y = p.gy;
        bomb.sx = bomb.sy = bomb.ox = bomb.oy = 0;
        this.fx.say(p.gx + 0.5, p.gy + 1, 'TAP TO THROW!', PAL.amber, 0);
        return true;
      }
    }
    if (p.magnet && this.world.isWalkable(p.gx + fx, p.gy + fy)) {
      const piece = this.world.pieceAt(p.gx + fx * 2, p.gy + fy * 2);
      if (piece) {
        const blocked = piece.cells.some((c) => {
          const x = c.x - fx, y = c.y - fy;
          return y <= this.voidY || this.world.isSealed(y) ||
            this.bombs.some((b) => !b.spent && b.x === x && b.y === y) ||
            this.flames.some((f) => f.x === x && f.y === y) ||
            this.players.some((other) => !other.down && other.moving && other.fromX === x && other.fromY === y);
        });
        if (!blocked && this.world.movePiece(piece, -fx, -fy, this.players)) {
          this.checkCrushEnemies();
          this.fx.say(p.gx + 0.5, p.gy + 1, 'PULL!', PAL.cyan, 0);
          audio.playPush();
        } else this.fx.say(p.gx + 0.5, p.gy + 1, 'BLOCKED', PAL.cyan, 0);
        return true;
      }
    }
    return false;
  }

  private freeToolTile(x: number, y: number, bomb: Bomb): boolean {
    return this.world.isWalkable(x, y) &&
      !this.bombs.some((b) => b !== bomb && !b.spent && b.x === x && b.y === y) &&
      !this.flames.some((f) => f.x === x && f.y === y) &&
      !this.players.some((p) => !p.down && ((p.gx === x && p.gy === y) || (p.moving && p.fromX === x && p.fromY === y))) &&
      !this.enemies.some((e) => (e.gx === x && e.gy === y) || (e.moving && e.fromX === x && e.fromY === y));
  }

  private placeBomb(p: Player): void {
    const active = this.bombs.filter((b) => b.owner === p.index && !b.spent).length;
    if (active >= p.bombs) return;
    if (this.bombs.some((b) => b.x === p.gx && b.y === p.gy)) return;
    if (!this.world.isWalkable(p.gx, p.gy)) return;

    this.bombs.push({
      x: p.gx,
      y: p.gy,
      fuse: p.bombFuse || BOMB_FUSE,
      power: p.power,
      owner: p.index,
      spent: false,
      tickTimer: 0,
      pierce: p.pierce,
    });
    this.fx.kick(0.6, 0.3);
  }

  /**
   * Walk a sliding bomb forward one tile at a time while the lane stays clear.
   * A bomb is a hazard the whole board has to path around, so it stops dead at
   * anything solid, anything alive, and any tile already burning.
   */
  private advanceSlide(b: Bomb, dt: number): void {
    if (!b.sx && !b.sy) return;
    const dx = b.sx ?? 0;
    const dy = b.sy ?? 0;

    b.slideT = (b.slideT ?? 0) - dt;
    while (b.slideT !== undefined && b.slideT <= 0) {
      const nx = b.x + dx;
      const ny = b.y + dy;
      const blocked =
        !this.world.isWalkable(nx, ny) ||
        ny <= this.voidY ||
        this.bombs.some((o) => o !== b && !o.spent && o.x === nx && o.y === ny) ||
        this.flames.some((f) => f.x === nx && f.y === ny) ||
        this.players.some(
          (p) => !p.down && ((p.gx === nx && p.gy === ny) || (p.moving && p.fromX === nx && p.fromY === ny)),
        ) ||
        this.enemies.some((e) => e.gx === nx && e.gy === ny);
      if (blocked) {
        b.sx = 0;
        b.sy = 0;
        b.slideT = 0;
        return;
      }
      b.x = nx;
      b.y = ny;
      b.slideT += BOMB_SLIDE_STEP;
    }
  }

  private updateBombs(dt: number): void {
    for (const b of this.bombs) {
      if (b.spent) continue;
      if (b.carriedBy !== undefined) {
        const carrier = this.players[b.carriedBy];
        b.x = carrier.gx; b.y = carrier.gy;
        if (carrier.down) b.carriedBy = undefined;
      }
      if (b.flight) {
        b.flight.remaining -= dt;
        if (b.flight.remaining <= 0) b.flight = undefined;
      }
      const visualX = b.x + (b.ox ?? 0);
      const visualY = b.y + (b.oy ?? 0);
      const sliding = !!(b.sx || b.sy);
      if (sliding) this.advanceSlide(b, dt);
      // Constant travel speed across tile boundaries, including the final tile.
      // Settle exactly at the center instead of leaving an exponential tail.
      const dx = b.x - visualX, dy = b.y - visualY;
      const distance = Math.hypot(dx, dy);
      const travel = dt / (sliding ? BOMB_SLIDE_STEP : b.kickSeconds ?? 0.11);
      const remaining = distance > 0 ? Math.max(0, 1 - travel / distance) : 0;
      b.ox = -dx * remaining;
      b.oy = -dy * remaining;
      // Lift suspends the remaining fuse, rather than resetting it on each grab.
      // A throw or a dropped bomb resumes from exactly that remaining time.
      const held = b.carriedBy !== undefined;
      if (!held) {
        b.fuse -= dt;
        b.tickTimer = (b.tickTimer ?? 0) - dt;
        if (b.tickTimer <= 0) {
          const rate = b.fuse > 1.2 ? 0.35 : b.fuse > 0.6 ? 0.22 : 0.12;
          b.tickTimer = rate;
          audio.playTick();
        }
      }

      if (!b.flight && ((!held && b.fuse <= 0) || this.flames.some((f) => f.x === b.x && f.y === b.y))) this.detonate(b);
    }
    this.bombs = this.bombs.filter((b) => !b.spent);
  }

  /**
   * A Gate socket only ever matches a Shard in its original spawn
   * orientation, so rotating one mid-run can only ever break it. A bomb
   * hitting an unseated Shard relocates it to open floor instead — useful
   * for freeing one wedged against a wall, and it can never scramble a
   * correctly-oriented piece into an unsolvable one.
   */
  private handleBombHitOnPiece(piece: Piece, hitPieces: Set<number>, x: number, y: number): boolean {
    if (hitPieces.has(piece.id)) return false;
    hitPieces.add(piece.id);

    if (this.world.ejectPiece(piece, this.players, this.bombs, Math.max(this.world.base, this.voidY + 1))) {
      this.fx.burst(x + 0.5, y + 0.5, 18, CONFETTI, 8);
      this.fx.say(x + 0.5, y + 1.3, 'EJECT!', PAL.cyan, 1);
      this.fx.kick(6, 5, 0.4);
      audio.playEject();
      return true;
    }
    return false;
  }

  private detonate(bomb: Bomb): void {
    if (bomb.spent) return;
    bomb.spent = true;

    audio.playExplosion();
    const blastId = this.nextBlastId++;
    const flame = (x: number, y: number, dx: number, dy: number, kind: number, breaking = false) =>
      this.addFlame(x, y, dx, dy, kind, breaking, bomb.owner, blastId);
    if (this.world.typeAt(bomb.x, bomb.y) === Cell.PICKUP) this.world.set(bomb.x, bomb.y, Cell.EMPTY);
    flame(bomb.x, bomb.y, 0, 0, 0);

    const hitPieces = new Set<number>();

    const dirs: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    for (const [dx, dy] of dirs) {
      for (let i = 1; i <= bomb.power; i++) {
        const x = bomb.x + dx * i;
        const y = bomb.y + dy * i;
        const t = this.world.typeAt(x, y);

        if (t === Cell.CORE) {
          // A core stops the arm and burns out, leaving plain wall behind.
          this.world.set(x, y, Cell.GATE);
          flame(x, y, dx, dy, 2, true);
          this.fx.burst(x + 0.5, y + 0.5, 20, [PAL.cyan, PAL.ink, PAL.magenta], 9);
          this.fx.say(Math.min(INNER_RIGHT - 1.5, Math.max(INNER_LEFT + 2, x + 0.5)), y + 1.3, 'CORE DOWN', PAL.cyan, 1);
          this.fx.kick(5, 5, 0.35);
          this.players[bomb.owner].score += 100;
          break;
        }
        if (t === Cell.SOLID || t === Cell.GATE) break;

        if (t === Cell.SHARD) {
          const piece = this.world.pieceAt(x, y);
          if (piece) {
            this.handleBombHitOnPiece(piece, hitPieces, x, y);
          }
          flame(x, y, dx, dy, 2, true);
          break;
        }

        if (t === Cell.SOFT) {
          this.world.destroySoft(x, y, (kind) => this.anyoneWants(kind));
          flame(x, y, dx, dy, 2, true);
          this.fx.burst(x + 0.5, y + 0.5, 9, [PAL.violet, PAL.solidTop, PAL.ink], 5);
          this.players[bomb.owner].score += 10;
          // Pierce tunnels the whole arm through brick. Walls, Gates and
          // Shards still stop it, so it can never chew open a puzzle.
          if (!bomb.pierce) break;
          continue;
        }

        if (t === Cell.PICKUP) this.world.set(x, y, Cell.EMPTY);

        const chained = this.bombs.find((b) => !b.spent && !b.flight && b.x === x && b.y === y);
        if (chained) {
          this.detonate(chained);
          break;
        }

        flame(x, y, dx, dy, i === bomb.power ? 2 : 1);
      }
    }

    const shake = 3.2 + bomb.power * 0.5;
    this.fx.kick(shake, shake * 0.9, 0.28);
    this.fx.freeze(0.035);
    this.fx.burst(bomb.x + 0.5, bomb.y + 0.5, 16, FLAME_COLORS, 8);
    this.fx.say(bomb.x + 0.5, bomb.y + 1.1, this.presentationRng.pick(BOOMS), PAL.amber, 1);

    // Near miss: standing right beside this blast's fire without being in it.
    const fire = this.flames.filter((f) => f.blastId === blastId);
    for (const p of this.livePlayers) {
      const inFire = fire.some((f) => f.x === p.gx && f.y === p.gy);
      const grazed = fire.some((f) => Math.abs(f.x - p.gx) + Math.abs(f.y - p.gy) === 1);
      if (!inFire && grazed) this.fx.say(p.gx + 0.5, p.gy + 1.3, 'CLOSE!', PAL.lime, 0);
    }
  }

  private addFlame(x: number, y: number, dx: number, dy: number, kind: number, breaking = false, owner?: number, blastId?: number): void {
    this.flames.push({ x, y, life: FLAME_TIME, max: FLAME_TIME, kind, dx, dy, breaking, owner, blastId });
  }

  private updateFlames(dt: number): void {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.flames.splice(i, 1);
        continue;
      }
      for (const p of this.players) {
        if (p.down || p.iframes > 0) continue;
        if (this.mode === 'coop' && f.owner !== undefined && f.owner !== p.index) continue;
        if (p.gx === f.x && p.gy === f.y) this.downPlayer(p, 'caught in the blast');
      }
      for (let e = this.enemies.length - 1; e >= 0; e--) {
        const en = this.enemies[e];
        if (en.gx !== f.x || en.gy !== f.y) continue;
        const damageSource = f.blastId ?? f;
        if (en.hitBlasts.has(damageSource)) continue;
        en.hitBlasts.add(damageSource);

        // Warden armor handling
        if (en.variant === 3 && en.hp > 1) {
          en.hp--;
          en.stun = 0.6;
          this.fx.burst(en.gx + 0.5, en.gy + 0.5, 16, [PAL.amber, PAL.ink], 8);
          this.fx.say(en.gx + 0.5, en.gy + 1.2, 'CRACKED!', PAL.amber, 1);
          this.fx.kick(4, 4, 0.3);
          audio.playZap();
          continue;
        }

        this.enemies.splice(e, 1);
        this.fx.burst(en.gx + 0.5, en.gy + 0.5, 14, [PAL.magenta, PAL.ink, PAL.violet], 7);
        this.fx.say(en.gx + 0.5, en.gy + 1, 'ZAP!', PAL.magenta, 0);
        this.addScoreAll(en.variant === 3 ? 250 : 100);
        this.earnedChips += en.variant === 3 ? 3 : 1;
        audio.playZap();
      }
    }
  }

  private updateEnemies(dt: number): void {
    // Consume pending enemy spawns from world generation
    while (this.world.pendingEnemySpawns.length > 0) {
      const spawn = this.world.pendingEnemySpawns.shift()!;
      this.enemies.push(new Enemy(spawn.x, spawn.y, spawn.variant));
    }

    const targets = this.livePlayers;
    for (const e of this.enemies) e.update(dt, this.world, this.rng, targets, this.bombs, this.flames);

    // Contact damage.
    for (const p of this.players) {
      if (p.down || p.iframes > 0) continue;
      for (const e of this.enemies) {
        if (Math.abs(e.rx - p.rx) < 0.6 && Math.abs(e.ry - p.ry) < 0.6) {
          this.downPlayer(p, 'overrun by daemons');
          break;
        }
      }
    }

    this.enemies = this.enemies.filter((e) => e.gy > this.voidY - 1);
  }

  private updateShards(dt: number): void {
    for (const p of this.world.pieces.values()) {
      p.ox *= Math.max(0, 1 - dt * 14);
      p.oy *= Math.max(0, 1 - dt * 14);
    }
  }

  private updateGates(): void {
    for (const seg of this.world.segments) {
      if (seg.kind !== 'gate' || seg.open) continue;
      if (seg.y1 < this.voidY - 2 || seg.y0 > this.camY + VIEW_ROWS + 6) continue;
      const cleared = this.world.resolveGate(seg);
      for (const y of cleared) this.onLineClear(y);
      if (seg.open) this.onGateOpen(seg.index, seg.isBoss, seg.y1);
    }
  }

  private onLineClear(y: number): void {
    this.linesCleared++;
    this.combo++;
    this.comboTimer = 4;
    this.comboBattery = Math.min(100, this.comboBattery + COMBO_BATTERY_PER_LINE);
    this.earnedChips += 5;

    const value = 500 * Math.max(1, this.combo);
    this.addScoreAll(value);

    // The reward that makes the puzzle worth solving under pressure: a clean
    // line physically shoves the Void back down the tower.
    this.rollbackVoid(3.5);

    if (this.comboBattery >= 100) {
      this.comboBattery = 0;
      this.rollbackVoid(VOID_ROLLBACK_ROWS);
      this.voidFreezeTimer = Math.max(this.voidFreezeTimer, 3);
      this.fx.say((INNER_LEFT + INNER_RIGHT) / 2 + 0.5, y + 2.2, 'COMBO SURGE!', PAL.cyan, 1.2);
    }

    this.fx.kick(9, 8, 0.75);
    this.fx.freeze(0.09);
    for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) {
      this.fx.burst(x + 0.5, y + 0.5, 7, CONFETTI, 9);
    }
    this.fx.say(
      (INNER_LEFT + INNER_RIGHT) / 2 + 0.5,
      y + 1.4,
      this.combo > 1 ? `${this.combo}x COMBO!` : 'LINE CLEAR!',
      PAL.lime,
      1,
    );
    audio.playLineClear();

    // Coop lifeline: a clean line rebuilds a downed partner.
    if (this.mode === 'coop') {
      for (const p of this.players) {
        if (!p.down) continue;
        const anchor = this.livePlayers[0];
        if (!anchor) continue;
        const spot = this.world.findOpen(anchor.gx, anchor.gy + 1);
        p.down = false;
        p.gx = spot.x;
        p.gy = spot.y;
        p.fromX = spot.x;
        p.fromY = spot.y;
        p.t = 1;
        p.iframes = IFRAMES * 1.5;
        this.fx.say(spot.x + 0.5, spot.y + 1.2, 'RECOMPILED!', PLAYER_COLORS[p.index], 1);
      }
    }
  }

  private onGateOpen(index: number, isBoss?: boolean, row?: number): void {
    this.gatesOpened++;
    this.chapter = Math.max(this.chapter, index + 1);

    if (isBoss) {
      this.addScoreAll(3000);
      this.earnedChips += 50;
      this.fx.kick(12, 14, 1.0);
      this.fx.say((INNER_LEFT + INNER_RIGHT) / 2 + 0.5, this.leadY + 3, 'BOSS PURGED!', PAL.magenta, 1);
    } else {
      this.addScoreAll(1000);
      this.earnedChips += 20;
      this.fx.kick(7, 9, 0.6);
      this.fx.say((INNER_LEFT + INNER_RIGHT) / 2 + 0.5, this.leadY + 3, 'GATE OPEN', PAL.cyan, 1);
    }
    // Confetti sweeps the whole gate row, so the payoff reads across the board.
    if (row !== undefined) {
      for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) this.fx.burst(x + 0.5, row + 0.5, 5, CONFETTI, 7);
    }
    audio.playGateOpen();
  }

  private updateVoid(dt: number): void {
    if (this.mode === 'tutorial') {
      this.voidY = -5;
      return;
    }

    const lead = this.leadY;
    let speed = (VOID_BASE_SPEED + this.pressure) * (1 + this.chapter * VOID_CHAPTER_RAMP);

    const lag = lead - this.voidY;
    if (lag > VOID_MAX_LAG) speed = Math.max(speed, (lag - VOID_MAX_LAG) * 2.0);
    speed = Math.max(speed, VOID_MIN_SPEED);

    if (this.voidFreezeTimer > 0) speed = 0;

    this.voidY += speed * dt;
    // Keep enough floor history for a three-line clear and its Combo Surge.
    this.world.pruneBelow(Math.floor(this.voidY) - 1, 16);

    for (const p of this.players) {
      if (p.down) continue;
      if (p.gy <= this.voidY) this.downPlayer(p, 'swallowed by the Void');
    }

    this.bombs = this.bombs.filter((b) => b.y > this.voidY - 1);
  }

  private updateCamera(dt: number): void {
    const target = Math.max(this.leadY - 5, this.voidY - 0.4);
    this.camY += (target - this.camY) * Math.min(1, dt * 5.5);
    if (this.camY < this.voidY - 1) this.camY = this.voidY - 1;
  }

  private downPlayer(p: Player, reason: string): void {
    if (!p.hurt()) {
      this.fx.say(p.gx + 0.5, p.gy + 1.2, 'BLOCKED!', PAL.cyan, 0);
      this.fx.kick(4, 4, 0.3);
      return;
    }
    for (const bomb of this.bombs) {
      if (bomb.carriedBy !== p.index) continue;
      bomb.carriedBy = undefined;
      bomb.x = p.gx; bomb.y = p.gy;
    }
    this.outcome = reason;
    this.fx.kick(10, 12, 0.9);
    this.fx.freeze(0.14);
    this.fx.burst(p.gx + 0.5, p.gy + 0.5, 26, [PLAYER_COLORS[p.index], PAL.ink, PAL.magenta], 9);
    this.fx.say(p.gx + 0.5, p.gy + 1.4, 'DELETED', PAL.magenta, 1);
    audio.playDeleted();
  }

  private checkCrushEnemies(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const piece = this.world.pieceAt(e.gx, e.gy);
      if (piece) {
        this.enemies.splice(i, 1);
        this.fx.freeze(0.06);
        this.fx.kick(7, 6, 0.35);
        this.fx.burst(e.gx + 0.5, e.gy + 0.5, 18, [PAL.magenta, PAL.lime, PAL.ink], 8);
        this.fx.say(e.gx + 0.5, e.gy + 1.2, 'CRUSHED!', PAL.lime, 1);
        audio.playZap();
        this.addScoreAll(e.variant === 3 ? 300 : 100);
        this.earnedChips += 3;
      }
    }
  }

  private addScoreAll(v: number): void {
    const live = this.livePlayers.length || this.players.length;
    for (const p of this.players) if (!p.down || live === 0) p.score += Math.round(v / live);
  }

  private checkEnd(): void {
    if (this.mode === 'versus') {
      const alive = this.livePlayers;
      if (alive.length <= 1 && this.players.length > 1) {
        this.phase = 'over';
        this.outcome = alive.length === 1 ? `PLAYER ${alive[0].index + 1} WINS` : 'MUTUAL DELETION';
        this.finalizeRun();
      }
      return;
    }
    if (this.livePlayers.length === 0) {
      this.phase = 'over';
      this.finalizeRun();
    }
  }

  private finalizeRun(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.mode === 'tutorial') {
      this.earnedChips = 0;
      return;
    }
    if (!this.persist) return;
    storage.addChips(this.earnedChips);
    storage.recordRunStats(this.linesCleared, Math.max(0, Math.floor(this.bestDepth)));
    if (this.mode === 'daily') {
      storage.recordDailyPlayed();
    }
    this.saveLocalScore();
  }

  get scoreEntry(): LeaderboardEntry {
    return {
      runId: this.runId, name: storage.getLastInitials(), score: this.score,
      sector: this.chapter + 1, depth: Math.max(0, Math.floor(this.bestDepth)),
      lines: this.linesCleared, date: this.date, mode: this.mode,
    };
  }

  get replay(): RunReplay | null {
    return this.recorder?.finish({ seed: this.seed, date: this.date, mode: this.mode, chassis: this.players[0].chassis }) ?? null;
  }

  saveLocalScore(): void {
    if (this.scoreSaved || !this.persist || this.phase !== 'over' || this.mode === 'tutorial' || this.score <= 0) return;
    this.scoreSaved = true;
    storage.addScore(this.scoreEntry);
  }


  togglePause(): void {
    if (this.phase === 'playing') this.phase = 'paused';
    else if (this.phase === 'paused') this.phase = 'playing';
  }
}
