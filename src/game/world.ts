import { Rng } from '../core/rng.js';
import {
  ARENA_ROWS,
  COLS,
  GATE_SPACER,
  INNER_LEFT,
  INNER_RIGHT,
  PICKUP_CHANCE,
  SOFT_BLOCK_CHANCE,
} from './constants.js';
import { Cell, PickupKind, type CellType, type GateRow, type GateSocket, type Piece, type Segment } from './types.js';
import { audio } from '../core/audio.js';
import type { Bomb, Player } from './entities.js';

interface Row {
  t: Uint8Array;
  /**
   * Per-tile payload: the piece id behind a SHARD, or the kind behind a
   * PICKUP. Int32 rather than Int16 because piece ids only ever climb, and a
   * wrapped id silently stops resolving back to its piece — the socket it sits
   * in then never counts as filled and the Gate simply never opens.
   */
  m: Int32Array;
}

/**
 * The tower. Rows are generated upward on demand and pruned from below as the
 * Void eats them, so a run is effectively endless at constant memory cost.
 */
export class World {
  private rows: Row[] = [];
  /** Absolute row index of `rows[0]`. */
  base = 0;
  /** Next absolute row index that still needs generating. */
  private genY = 0;
  private chunkIndex = 0;

  readonly pieces = new Map<number, Piece>();
  readonly segments: Segment[] = [];
  /**
   * Rows of an uncleared Gate. The empty notches are shard-shaped holes in a
   * force field: a Shard slides in, a body does not. Without this the player
   * could just walk through the gap and the whole puzzle layer is optional.
   */
  private readonly sealedRows = new Set<number>();
  pendingEnemySpawns: Array<{ x: number; y: number; variant: number }> = [];

  constructor(private readonly rng: Rng, private readonly dropRng: Rng = new Rng(0x64726f70)) {
    this.ensureUpTo(ARENA_ROWS);
  }

  // ---------------------------------------------------------------- access

  get top(): number {
    return this.base + this.rows.length - 1;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < COLS && y >= this.base && y <= this.top;
  }

  typeAt(x: number, y: number): CellType {
    if (x < 0 || x >= COLS) return Cell.SOLID;
    const r = this.rows[y - this.base];
    if (!r) return Cell.SOLID;
    return r.t[x] as CellType;
  }

  metaAt(x: number, y: number): number {
    const r = this.rows[y - this.base];
    return r ? r.m[x] : 0;
  }

  set(x: number, y: number, t: CellType, meta = 0): void {
    const r = this.rows[y - this.base];
    if (!r || x < 0 || x >= COLS) return;
    r.t[x] = t;
    r.m[x] = meta;
  }

  /** True while `y` is a Gate row that has not been cleared. */
  isSealed(y: number): boolean {
    return this.sealedRows.has(y);
  }

  /** Walkable for actors (pickups are walkable, everything solid is not). */
  isWalkable(x: number, y: number): boolean {
    if (this.sealedRows.has(y)) return false;
    const t = this.typeAt(x, y);
    return t === Cell.EMPTY || t === Cell.PICKUP;
  }

  pieceAt(x: number, y: number): Piece | undefined {
    if (this.typeAt(x, y) !== Cell.SHARD) return undefined;
    return this.pieces.get(this.metaAt(x, y));
  }

  segmentAt(y: number): Segment | undefined {
    return this.segments.find((s) => y >= s.y0 && y <= s.y1);
  }

  /** The lowest gate segment at or above `y` that is still shut. */
  nextGate(y: number): Segment | undefined {
    return this.segments.find((s) => s.kind === 'gate' && !s.open && s.y1 >= y);
  }

  // ------------------------------------------------------------ generation

  ensureUpTo(y: number): void {
    let guard = 0;
    while (this.genY <= y + 4 && guard++ < 40) this.generateChunk();
  }

  private pushRow(): Row {
    const row: Row = { t: new Uint8Array(COLS), m: new Int32Array(COLS) };
    row.t[0] = Cell.SOLID;
    row.t[COLS - 1] = Cell.SOLID;
    this.rows.push(row);
    this.genY++;
    return row;
  }

  /**
   * A chunk is one Bomberman arena followed by one Gate. They are generated
   * together because the Gate's slot widths decide which Shards the arena
   * below it has to contain.
   */
  private generateChunk(): void {
    const chunk = this.chunkIndex++;
    const arenaY0 = this.genY;
    const arenaH = ARENA_ROWS + Math.min(6, chunk);
    const arenaY1 = arenaY0 + arenaH - 1;
    // Core Gates need no shard staging floor: the lattice runs the full arena.

    for (let y = arenaY0; y <= arenaY1; y++) this.generateArenaRow(y, chunk, false);
    this.segments.push({ kind: 'arena', y0: arenaY0, y1: arenaY1, index: chunk });

    // Breathing room between the arena and the wall you have to solve.
    for (let i = 0; i < GATE_SPACER; i++) this.pushRow();

    const isBoss = (chunk + 1) % 5 === 0;
    const gateRowCount = isBoss ? Math.min(3, 2 + Math.floor(chunk / 5)) : Math.min(3, 1 + Math.floor(chunk / 3));
    const gateY0 = this.genY;
    const gateRows: GateRow[] = [];
    // Walls get tougher the higher you climb: one more core every two
    // sectors, plus one on boss gates, up to the five a row has room for.
    const coresPerRow = Math.min(5, 2 + Math.floor(chunk / 2) + (isBoss ? 1 : 0));

    for (let i = 0; i < gateRowCount; i++) {
      this.pushRow();
      const rowY = this.genY - 1;
      const cores = this.buildCoreRow(rowY, coresPerRow);
      gateRows.push({ y: rowY, cleared: false, slots: [], cores });
      this.sealedRows.add(rowY);
      // An empty corridor between stacked gate rows so shards can be staged and inserted with full clearance.
      if (i < gateRowCount - 1) {
        for (let s = 0; s < 3; s++) this.pushRow();
      }
    }

    const gateY1 = this.genY - 1;
    this.segments.push({
      kind: 'gate',
      y0: gateY0 - GATE_SPACER,
      y1: gateY1,
      index: chunk,
      rows: gateRows,
      open: false,
      isBoss,
    });

    // Ceiling above the gate so the arena above reads as a separate space with full clearance for tall polyominoes.
    for (let s = 0; s < 3; s++) this.pushRow();

    // Spawn enemies per chunk strategically in the arena
    const enemyCount = (isBoss ? 4 : 2) + Math.min(3, Math.floor(chunk * 0.5));
    for (let i = 0; i < enemyCount; i++) {
      const minYVal = chunk === 0 ? arenaY0 + 4 : arenaY0;
      const y = this.rng.range(minYVal, arenaY1);
      
      const candidates: number[] = [];
      for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) {
        if (this.typeAt(x, y) === Cell.EMPTY) {
          candidates.push(x);
        }
      }
      
      if (candidates.length > 0) {
        const x = this.rng.pick(candidates);
        let variant = 0;
        if (isBoss && i === 0) {
          variant = 3; // Guaranteed Warden in Boss sectors
        } else if (chunk === 0) {
          variant = 0;
        } else if (chunk <= 2) {
          variant = this.rng.chance(0.35) ? 1 : 0;
        } else {
          const roll = this.rng.next();
          if (roll < 0.35) variant = 0;
          else if (roll < 0.65) variant = 1;
          else if (roll < 0.85) variant = 2;
          else variant = 3;
        }

        this.pendingEnemySpawns.push({ x, y, variant });
      }
    }
  }

  private generateArenaRow(y: number, chunk: number, staging: boolean): void {
    const row = this.pushRow();
    const spawnZone = chunk === 0 && y <= 3;
    for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) {
      // Classic Bomberman lattice: a hard pillar on every even/even tile.
      if (!staging && x % 2 === 0 && y % 2 === 0) {
        row.t[x] = Cell.SOLID;
        continue;
      }
      if (spawnZone) continue;
      const density = staging ? SOFT_BLOCK_CHANCE * 0.75 : SOFT_BLOCK_CHANCE;
      if (this.rng.chance(density)) row.t[x] = Cell.SOFT;
    }
  }

  /**
   * Lay out one Core Gate row: a solid wall with `count` reactor cores spread
   * across it, at least one empty tile apart so one blast takes one core.
   */
  private buildCoreRow(y: number, count: number): number[] {
    const row = this.rows[y - this.base];
    for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) row.t[x] = Cell.GATE;
    const span = INNER_RIGHT - INNER_LEFT + 1;
    const cores: number[] = [];
    for (let i = 0; i < count; i++) {
      // One core per equal band, jittered inside it, so they never cluster.
      const band0 = INNER_LEFT + Math.floor((span * i) / count);
      const band1 = INNER_LEFT + Math.floor((span * (i + 1)) / count) - 2;
      const x = this.rng.range(band0, Math.max(band0, band1));
      row.t[x] = Cell.CORE;
      cores.push(x);
    }
    return cores;
  }


  // -------------------------------------------------------------- mutation

  /**
   * Sokoban push. Returns true if the whole shard moved one tile.
   *
   * A shard that has seated into a Gate row cannot be pushed up out of it.
   * Without that rule a shard shoved at a notch sails straight through and is
   * stranded above the wall, quietly making the Gate unsolvable.
   */
  movePiece(piece: Piece, dx: number, dy: number, players?: Player[], pusher?: Player): boolean {
    if (piece.locked) return false;
    const minY = Math.min(...piece.cells.map((c) => c.y));

    // Prevent pushing a shard upward past a sealed Gate row once its bottom has seated
    if (dy > 0) {
      for (const sealedY of this.sealedRows) {
        if (minY === sealedY) return false;
        if (minY < sealedY && minY + dy > sealedY) return false;
      }
    }

    // Players block shard movement (excluding the pusher, who steps in lockstep with the piece)
    if (players) {
      const hitPlayer = players.some(
        (p) => p !== pusher && !p.down && piece.cells.some((c) => c.x + dx === p.gx && c.y + dy === p.gy),
      );
      if (hitPlayer) return false;
    }

    const own = new Set(piece.cells.map((c) => `${c.x},${c.y}`));
    for (const c of piece.cells) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      if (nx < INNER_LEFT || nx > INNER_RIGHT) return false;
      if (ny < this.base || ny > this.top) return false;
      if (own.has(`${nx},${ny}`)) continue;
      const t = this.typeAt(nx, ny);
      if (t !== Cell.EMPTY && t !== Cell.PICKUP) return false;
    }
    for (const c of piece.cells) this.set(c.x, c.y, Cell.EMPTY);
    for (const c of piece.cells) {
      c.x += dx;
      c.y += dy;
      this.set(c.x, c.y, Cell.SHARD, piece.id);
    }
    piece.ox = -dx;
    piece.oy = -dy;
    const newlyLocked = this.pieceMatchesSocket(piece);
    piece.locked = newlyLocked;
    if (newlyLocked) {
      audio.playSeated();
    }
    return true;
  }

  /**
   * A Shard seats only when every one of its cells exactly overlays a single
   * multi-row socket blueprint. Width alone is intentionally insufficient,
   * and mirrored or rotated variants of the right shape do NOT match — only
   * the exact silhouette shown by the Gate does. (Bombing a Shard therefore
   * relocates it rather than rotating it — see Game.handleBombHitOnPiece.)
   */
  private pieceMatchesSocket(piece: Piece): boolean {
    for (const segment of this.segments) {
      if (segment.kind !== 'gate' || segment.open || !segment.rows) continue;
      for (const row of segment.rows) {
        if (row.cleared || !row.sockets) continue;
        for (const socket of row.sockets) {
          if (this.pieceMatchesSpecificSocket(piece, row, socket)) return true;
        }
      }
    }
    return false;
  }

  /** Return the one exact Shard occupying a socket, or undefined. */
  pieceInSocket(row: GateRow, socket: GateSocket): Piece | undefined {
    let match: Piece | undefined;
    for (const [cx, cy] of socket.cells) {
      const piece = this.pieceAt(socket.startX + cx, row.y + cy);
      if (!piece || (match && match.id !== piece.id)) return undefined;
      match = piece;
    }
    return match && this.pieceMatchesSpecificSocket(match, row, socket) ? match : undefined;
  }

  private pieceMatchesSpecificSocket(piece: Piece, row: GateRow, socket: GateSocket): boolean {
    if (socket.cells.length !== piece.cells.length) return false;
    const pieceCells = new Set(piece.cells.map((cell) => `${cell.x},${cell.y}`));
    return socket.cells.every(([cx, cy]) => pieceCells.has(`${socket.startX + cx},${row.y + cy}`));
  }

  /** Shove a shard up to `power` tiles; returns how far it actually went. */
  blastPiece(piece: Piece, dx: number, dy: number, power: number, players?: Player[]): number {
    let moved = 0;
    for (let i = 0; i < power; i++) {
      if (!this.movePiece(piece, dx, dy, players)) break;
      moved++;
    }
    return moved;
  }

  /**
   * Blow a jammed Shard back out of a Gate and drop it into open floor below.
   *
   * Seating the wrong Shard in a notch would otherwise strand a run: the piece
   * cannot be pushed back up, and the notch it half-fills can never complete.
   * Recovery costs a bomb and the time the Void charges for it.
   */
  ejectPiece(piece: Piece, players: Player[] = [], bombs: Bomb[] = [], minimumY = this.base): boolean {
    // A locked piece is already seated correctly — a bomb catching it in a
    // blast radius must not undo that, even if a sibling socket in the same
    // row is still open and the wall hasn't dropped yet.
    if (piece.locked) return false;
    const original = piece.cells.map((c) => ({ ...c }));
    const minX = Math.min(...original.map((c) => c.x));
    const minY = Math.min(...original.map((c) => c.y));
    const offs = original.map((c) => [c.x - minX, c.y - minY] as const);
    const w = Math.max(...offs.map((o) => o[0])) + 1;

    for (const c of original) this.set(c.x, c.y, Cell.EMPTY);

    const xs: number[] = [];
    for (let x = INNER_LEFT; x <= INNER_RIGHT - w + 1; x++) {
      xs.push(x);
    }
    xs.sort((a, b) => {
      const diff = Math.abs(a - minX) - Math.abs(b - minX);
      if (diff !== 0) return diff;
      return a - b;
    });

    // A shard may never be relocated across a sealed Gate row. On the far side
    // it is unreachable for good and the Gate it belongs to can never be
    // solved, so a stray blast next to a wall would quietly kill the run.
    // A shard jammed in a notch counts as being on the near side, which is
    // what makes bombing one out of the wall drop it back onto open floor.
    let ceiling = Infinity;
    let floor = -Infinity;
    for (const sealedY of this.sealedRows) {
      if (sealedY >= minY) ceiling = Math.min(ceiling, sealedY);
      else floor = Math.max(floor, sealedY);
    }

    const ys: number[] = [];
    // Try same level and upward first (safe from Void)
    for (let y = minY; y <= minY + 6; y++) {
      ys.push(y);
    }
    // Fall back to downward
    for (let y = minY - 1; y >= this.base + 1; y--) {
      ys.push(y);
    }

    for (const y of ys) {
      if (y <= minimumY) continue;
      for (const x of xs) {
        // Enforce actual relocation to a new coordinate
        if (x === minX && y === minY) continue;

        const fits = offs.every(([ox, oy]) => {
          if (players.some(p => !p.down && ((p.gx === x + ox && p.gy === y + oy) ||
            (p.moving && p.fromX === x + ox && p.fromY === y + oy)))) return false;
          if (bombs.some(b => !b.spent && b.x === x + ox && b.y === y + oy)) return false;
          if (y + oy >= ceiling || y + oy <= floor) return false;
          if (this.sealedRows.has(y + oy)) return false;
          const t = this.typeAt(x + ox, y + oy);
          return t === Cell.EMPTY || t === Cell.SOFT || t === Cell.PICKUP;
        });
        if (!fits) continue;
        piece.cells = offs.map(([ox, oy]) => ({ x: x + ox, y: y + oy }));
        for (const c of piece.cells) this.set(c.x, c.y, Cell.SHARD, piece.id);
        piece.locked = false;
        piece.ox = 0;
        piece.oy = 0;
        return true;
      }
    }

    // Nowhere to land: leave the shard exactly where it was.
    for (const c of original) this.set(c.x, c.y, Cell.SHARD, piece.id);
    return false;
  }

  /**
   * `usable` is the squad's answer to "would anyone actually gain from this?".
   * Anything it rejects — a second Kick, a Blast+ at max power — leaves the
   * table before the roll, so the odds redistribute onto drops that still
   * mean something instead of being spent on a walk-over no-op.
   */
  destroySoft(x: number, y: number, usable: (kind: number) => boolean = () => true): boolean {
    if (this.typeAt(x, y) !== Cell.SOFT) return false;
    if (this.dropRng.chance(PICKUP_CHANCE)) {
      // Core stat boosts remain common. Void-control tools are deliberately
      // rarer, while line clears provide the reliable Combo Battery route.
      const kinds = [
        PickupKind.FIRE, PickupKind.FIRE, PickupKind.FIRE,
        PickupKind.BOMB, PickupKind.BOMB,
        PickupKind.SPEED, PickupKind.SPEED,
        PickupKind.SHIELD, PickupKind.SHIELD,
        PickupKind.KICK, PickupKind.KICK,
        PickupKind.SLIDE, PickupKind.SLIDE,
        PickupKind.PIERCE, PickupKind.PIERCE,
        PickupKind.LIFT, PickupKind.LIFT,
        PickupKind.ROLLBACK, PickupKind.FREEZE,
      ];
      const live = kinds.filter(usable);
      // The Void tools are always usable, so `live` is only empty if a caller
      // filters everything out; fall back to the full table rather than
      // silently stop dropping.
      this.set(x, y, Cell.PICKUP, this.dropRng.pick(live.length ? live : kinds));
    } else {
      this.set(x, y, Cell.EMPTY);
    }
    return true;
  }

  /** Clear Gate rows only when every multi-row socket has an exact Shard. */
  resolveGate(segment: Segment): number[] {
    if (segment.kind !== 'gate' || !segment.rows) return [];
    const cleared: number[] = [];
    for (const gr of segment.rows) {
      if (gr.cleared) continue;
      if (gr.cores) {
        if (gr.cores.some((x) => this.typeAt(x, gr.y) === Cell.CORE)) continue;
        gr.cleared = true;
        this.sealedRows.delete(gr.y);
        cleared.push(gr.y);
        for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) this.set(x, gr.y, Cell.EMPTY);
        continue;
      }
      if (!gr.sockets?.length) continue;
      const seated = gr.sockets.map((socket) => this.pieceInSocket(gr, socket));
      if (seated.some((piece) => !piece)) continue;

      gr.cleared = true;
      this.sealedRows.delete(gr.y);
      cleared.push(gr.y);

      const piecesToClean = new Set(seated as Piece[]);
      for (let x = INNER_LEFT; x <= INNER_RIGHT; x++) {
        this.set(x, gr.y, Cell.EMPTY);
      }

      for (const piece of piecesToClean) {
        for (const c of piece.cells) {
          this.set(c.x, c.y, Cell.EMPTY);
        }
        this.pieces.delete(piece.id);
      }
    }
    if (segment.rows.every((r) => r.cleared)) segment.open = true;
    return cleared;
  }

  /** Drop everything the Void has swallowed. */
  pruneBelow(y: number, retainedRows = 0): void {
    while (this.base < y - retainedRows && this.rows.length > 1) {
      this.rows.shift();
      this.base++;
    }
    for (const [id, p] of this.pieces) {
      const survivors = p.cells.filter((c) => c.y >= y);
      if (survivors.length === p.cells.length) continue;
      // Once the Void has taken any part of a Shard the rest is dead weight: a
      // socket wants an exact cell count, so a fragment can never seat again,
      // and leaving it behind just puts an unusable block wearing a key's
      // colours in the player's way. Its tiles go too — a SHARD tile with no
      // piece behind it reads as an invisible wall to everything that moves.
      for (const c of p.cells) this.set(c.x, c.y, Cell.EMPTY);
      p.cells = [];
      this.pieces.delete(id);
    }
    while (this.segments.length && this.segments[0].y1 < this.base - 2) this.segments.shift();
    for (const y of this.sealedRows) if (y < this.base) this.sealedRows.delete(y);
  }

  /** Nearest walkable tile to (x, y), searched outward. Used for spawns. */
  findOpen(x: number, y: number): { x: number; y: number } {
    for (let r = 0; r < 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < INNER_LEFT || nx > INNER_RIGHT) continue;
          if (this.isWalkable(nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return { x, y };
  }
}
