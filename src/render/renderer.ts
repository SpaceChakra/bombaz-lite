import { BOMB_FUSE, BOMB_THROW_SECONDS, COLS, VIEW_ROWS } from '../game/constants';
import type { Game } from '../game/game';
import { Cell, PickupKind, type GateRow, type GateSocket } from '../game/types';
import { hash2, makeHalftone } from './fx';
import {
  FLAME_COLORS,
  PAL,
  PLAYER_COLORS,
  PLAYER_DARK,
  SHARD_COLORS,
  SHARD_GLYPHS,
  getEraPalette,
  type EraPalette,
} from './palette';
import { storage } from '../core/storage';


const DISPLAY = "'Archivo Black', 'Arial Black', system-ui, sans-serif";
const UI = "'Space Grotesk', system-ui, sans-serif";

interface Layout {
  tile: number;
  boardX: number;
  boardY: number;
  boardW: number;
  boardH: number;
  hudX: number;
  hudY: number;
  hudW: number;
  hudH: number;
  /** Left rail, wide screens only. Zero width when there is no room. */
  railX: number;
  railW: number;
  stacked: boolean;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scene: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private halftone: CanvasPattern | null;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private layout!: Layout;
  private supportsFilter: boolean;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.scene = document.createElement('canvas');
    this.sctx = this.scene.getContext('2d', { alpha: false })!;
    this.halftone = makeHalftone(7, 1.2, 0.14);
    this.supportsFilter = typeof this.ctx.filter === 'string';
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private idleT = 0;

  // Presentation-only state for the current run. It lives here, not on Game,
  // so none of it can leak into the simulation a replay has to reproduce.
  private fxGame: Game | null = null;
  private lastFrame = 0;
  private shownScore = 0;
  private bestToBeat = 0;
  private bestAnnounced = false;
  private gatesSeen = 0;
  private gateNudge = 0;
  private overT = 0;

  /** Advance the per-run presentation state; resets when a new run starts. */
  private tickPresentation(game: Game): void {
    const now = performance.now();
    if (this.fxGame !== game) {
      this.fxGame = game;
      this.shownScore = 0;
      const solo = game.mode !== 'versus' && game.mode !== 'tutorial';
      this.bestToBeat = solo ? storage.getScores(game.mode)[0]?.score ?? 0 : 0;
      this.bestAnnounced = false;
      this.gatesSeen = game.gatesOpened;
      this.gateNudge = 0;
      this.overT = 0;
      this.lastFrame = now;
    }
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // Score rolls up instead of snapping; big jumps still land within ~0.4s.
    const gap = game.score - this.shownScore;
    this.shownScore = gap <= 0 ? game.score : Math.min(game.score, this.shownScore + Math.max(1, gap * Math.min(1, dt * 9)));
    if (!this.bestAnnounced && this.bestToBeat > 0 && game.score > this.bestToBeat && game.phase === 'playing') {
      this.bestAnnounced = true;
      const lead = game.livePlayers[0];
      if (lead) {
        game.fx.say(lead.gx + 0.5, lead.gy + 1.6, 'NEW BEST!', PAL.amber, 1);
        game.fx.burst(lead.gx + 0.5, lead.gy + 0.5, 14, [PAL.amber, PAL.ink], 7);
      }
    }

    if (game.gatesOpened > this.gatesSeen) this.gateNudge = 1;
    this.gatesSeen = game.gatesOpened;
    this.gateNudge = Math.max(0, this.gateNudge - dt * 3);

    this.overT = game.phase === 'over' ? this.overT + dt : 0;
  }

  /** Attract-mode backdrop shown behind the title and help panels. */
  drawIdle(): void {
    this.idleT += 1 / 60;
    const g = this.sctx;
    g.save();
    g.fillStyle = PAL.void;
    g.fillRect(0, 0, this.w, this.h);
    this.drawBackdrop(g, this.idleT);

    // A slow ghost of the Void edge, so the menu already tells the story.
    const y = this.h * (0.72 + Math.sin(this.idleT * 0.4) * 0.03);
    const edge = g.createLinearGradient(0, y - 160, 0, y + 40);
    edge.addColorStop(0, 'rgba(255,45,149,0)');
    edge.addColorStop(0.75, 'rgba(255,45,149,0.28)');
    edge.addColorStop(1, 'rgba(155,92,255,0.5)');
    g.fillStyle = edge;
    g.fillRect(0, y - 160, this.w, 200);
    g.fillStyle = PAL.void;
    g.fillRect(0, y, this.w, this.h - y);
    this.drawGrain(g);
    g.restore();

    const c = this.ctx;
    c.filter = 'none';
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(this.scene, 0, 0, this.w, this.h);
    this.drawVignette(c, 0, this.idleT);
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    for (const c of [this.canvas, this.scene]) {
      c.width = Math.floor(this.w * this.dpr);
      c.height = Math.floor(this.h * this.dpr);
    }
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.computeLayout();
  }

  private computeLayout(): void {
    const pad = Math.min(this.w, this.h) * 0.03;
    // Wide screens get a rail on each side so the shaft sits dead centre —
    // a single rail pushes the board off-axis and the frame reads lopsided.
    const stacked = this.w / this.h < 1.15;

    if (stacked) {
      const hudReserve = 96;
      const tile = Math.floor(
        Math.min((this.w - pad * 2) / COLS, (this.h - hudReserve - pad * 2) / VIEW_ROWS),
      );
      const boardW = tile * COLS;
      const boardH = tile * VIEW_ROWS;
      // On a tall phone the board is width-bound, so it never fills the
      // screen. Park it under the HUD and give the leftover bottom strip to
      // the thumbs — the board should not live where your hands are.
      const boardY = Math.round(hudReserve + pad * 2);
      this.layout = {
        tile,
        boardX: Math.round((this.w - boardW) / 2),
        boardY,
        boardW,
        boardH,
        hudX: pad,
        hudY: pad,
        hudW: this.w - pad * 2,
        hudH: hudReserve,
        railX: 0,
        railW: 0,
        stacked,
      };
      return;
    }

    const railW = Math.max(180, Math.min(300, this.w * 0.19));
    const availW = this.w - (railW + pad) * 2 - pad;
    const tile = Math.floor(Math.min(availW / COLS, (this.h - pad * 2) / VIEW_ROWS));
    const boardW = tile * COLS;
    const boardH = tile * VIEW_ROWS;
    const boardX = Math.round((this.w - boardW) / 2);
    const boardY = Math.round((this.h - boardH) / 2);
    const leftFits = boardX - pad - railW >= pad * 0.5;

    this.layout = {
      tile,
      boardX,
      boardY,
      boardW,
      boardH,
      hudX: boardX + boardW + pad,
      hudY: boardY,
      hudW: Math.min(railW, this.w - (boardX + boardW + pad) - pad),
      hudH: boardH,
      railX: leftFits ? boardX - pad - railW : 0,
      railW: leftFits ? railW : 0,
      stacked,
    };
  }

  // ------------------------------------------------------------ transforms

  private sx(x: number): number {
    return this.layout.boardX + x * this.layout.tile;
  }

  private sy(y: number, camY: number): number {
    const L = this.layout;
    return L.boardY + L.boardH - (y - camY + 1) * L.tile;
  }

  // ----------------------------------------------------------------- frame

  draw(game: Game, alpha = 1): void {
    const g = this.sctx;
    const L = this.layout;
    const cam = game.camY;
    const era = getEraPalette(game.chapter);
    this.tickPresentation(game);

    g.save();
    g.fillStyle = era.void;
    g.fillRect(0, 0, this.w, this.h);

    this.drawBackdrop(g, game.time, era);

    // Clip to the board so the tower reads as a physical shaft.
    g.save();
    g.beginPath();
    g.rect(L.boardX, L.boardY, L.boardW, L.boardH);
    g.clip();

    const shakeEnabled = storage.getSettings().screenShake;
    const shakeA = shakeEnabled ? game.fx.shake : 0;
    if (shakeA > 0.05) {
      g.translate((Math.random() - 0.5) * shakeA, (Math.random() - 0.5) * shakeA);
    }
    // Opening a gate bumps the camera up a touch: the board dips, then settles.
    if (shakeEnabled && this.gateNudge > 0) {
      g.translate(0, Math.sin(this.gateNudge * Math.PI) * L.tile * 0.35);
    }
    // Game over: ease in on the first runner while the Void washes the board.
    const zoom = Math.min(1, this.overT / 0.6);
    const ease = 1 - (1 - zoom) * (1 - zoom);
    const focus = game.players[0];
    if (ease > 0 && focus) {
      const fx = this.sx(focus.rx) + L.tile / 2;
      const fy = this.sy(focus.ry, cam) + L.tile / 2;
      const k = 1 + ease * 0.14;
      g.translate(fx, fy);
      g.scale(k, k);
      g.translate(-fx, -fy);
    }

    this.drawShaft(g, cam, era);
    this.drawTiles(g, game, cam, era);
    this.drawShards(g, game, cam);
    this.drawGateStatus(g, game, cam);
    this.drawBombs(g, game, cam, game.phase === 'playing' && game.fx.hitStop <= 0 ? alpha : 1);
    this.drawFlames(g, game, cam);
    this.drawEnemies(g, game, cam);
    this.drawPlayers(g, game, cam);
    this.drawVoid(g, game, cam);
    this.drawParticles(g, game, cam);
    this.drawTexts(g, game, cam);
    if (this.overT > 0) this.drawVoidWash(g);
    this.drawBoardFrame(g);
    g.restore();

    this.drawGrain(g);
    g.restore();

    this.composite(game);
    this.drawHud(game);
  }

  /** Copy the scene to the visible canvas, adding print misregistration. */
  private composite(game: Game): void {
    const c = this.ctx;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.filter = 'none';
    c.drawImage(this.scene, 0, 0, this.w, this.h);

    // Misregistration is an *event*, not an ambient filter: the additive
    // passes lift the whole frame, so leaving it on all the time bleaches the
    // art. Only impacts and genuine Void panic earn it.
    const chromaticEnabled = storage.getSettings().chromaticAberration;
    const ab = chromaticEnabled ? game.fx.aberration + Math.max(0, game.danger - 0.6) * 7 : 0;
    if (ab > 0.6 && this.supportsFilter) {
      const d = Math.min(9, ab);
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = Math.min(0.3, 0.09 + ab * 0.03);
      c.filter = 'grayscale(1) sepia(1) hue-rotate(265deg) saturate(7)';
      c.drawImage(this.scene, -d, 0, this.w, this.h);
      c.filter = 'grayscale(1) sepia(1) hue-rotate(140deg) saturate(7)';
      c.drawImage(this.scene, d, 0, this.w, this.h);
      c.filter = 'none';
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
    }

    if (game.fx.flash > 0.01) {
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = `rgba(255,246,255,${Math.min(0.55, game.fx.flash * 0.5)})`;
      c.fillRect(0, 0, this.w, this.h);
      c.globalCompositeOperation = 'source-over';
    }

    this.drawVignette(c, game.danger, game.time);
  }

  // ------------------------------------------------------------ background

  private drawBackdrop(g: CanvasRenderingContext2D, t: number, era?: EraPalette): void {
    const grad = g.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, era ? era.backdropTop : '#150a2e');
    grad.addColorStop(0.55, era ? era.backdropMid : '#0c0520');
    grad.addColorStop(1, era ? era.backdropBot : PAL.void);
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);

    // Parallax data streams: the tower is a machine, and it is still running.
    g.save();
    g.globalAlpha = 0.2;
    for (let i = 0; i < 26; i++) {
      const seed = hash2(i, 7);
      const x = seed * this.w;
      const speed = 40 + seed * 130;
      const len = 60 + seed * 220;
      const y = ((t * speed + seed * 2000) % (this.h + len)) - len;
      g.fillStyle = i % 3 === 0 ? PAL.cyan : (era ? era.gateEdge : PAL.violet);
      g.fillRect(x, this.h - y, 1.5, len);
    }
    g.restore();
  }

  private drawShaft(g: CanvasRenderingContext2D, cam: number, era?: EraPalette): void {
    const L = this.layout;
    g.fillStyle = era ? era.deep : PAL.deep;
    g.fillRect(L.boardX, L.boardY, L.boardW, L.boardH);

    g.strokeStyle = era ? era.grid : PAL.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= COLS; x++) {
      const px = Math.round(this.sx(x)) + 0.5;
      g.moveTo(px, L.boardY);
      g.lineTo(px, L.boardY + L.boardH);
    }
    const y0 = Math.floor(cam) - 1;
    for (let y = y0; y <= y0 + VIEW_ROWS + 2; y++) {
      const py = Math.round(this.sy(y, cam)) + 0.5;
      g.moveTo(L.boardX, py);
      g.lineTo(L.boardX + L.boardW, py);
    }
    g.stroke();
  }

  // ------------------------------------------------------------ world tiles

  private dissolveAmount(game: Game, y: number): number {
    // Rows just above the Void begin pixel-eating themselves — the Pac-Man 256
    // "digital deletion" read, but per-tile so it stays legible.
    const d = (game.voidY + 2.4 - y) / 3.0;
    return Math.max(0, Math.min(1, d));
  }

  private drawTiles(g: CanvasRenderingContext2D, game: Game, cam: number, era?: EraPalette): void {
    const L = this.layout;
    const w = game.world;
    const yStart = Math.max(w.base, Math.floor(cam) - 1);
    const yEnd = Math.min(w.top, Math.floor(cam) + VIEW_ROWS + 1);

    for (let y = yStart; y <= yEnd; y++) {
      const dissolve = this.dissolveAmount(game, y);
      const seg = w.segmentAt(y);
      const gateRow = seg?.rows?.find((r) => r.y === y && !r.cleared);

      if (gateRow) {
        this.drawGateSockets(g, gateRow, cam, game);
      }

      for (let x = 0; x < COLS; x++) {
        const t = w.typeAt(x, y);
        const px = this.sx(x);
        const py = this.sy(y, cam);

        if (gateRow && t === Cell.EMPTY) {
          this.drawSlot(g, px, py, L.tile, game.time);
          continue;
        }
        if (t === Cell.EMPTY || t === Cell.SHARD) continue;

        if (t === Cell.SOLID) {
          this.drawBlock(g, px, py, L.tile, dissolve, x, y, false, era);
        } else if (t === Cell.SOFT) {
          this.drawBlock(g, px, py, L.tile, dissolve, x, y, true, era);
        } else if (t === Cell.GATE) {
          this.drawGateBlock(g, px, py, L.tile, dissolve, x, y, game.time, seg?.isBoss, era);
        } else if (t === Cell.CORE) {
          this.drawGateBlock(g, px, py, L.tile, dissolve, x, y, game.time, seg?.isBoss, era);
          this.drawCore(g, px, py, L.tile, game.time + x * 0.7);
        } else if (t === Cell.PICKUP) {
          this.drawPickup(g, px, py, L.tile, w.metaAt(x, y), game.time);
        }
      }
    }
  }

  /**
   * Chunky extruded block. Hard and soft blocks differ in hue, silhouette and
   * surface detail, so "can I blow this up?" is answerable at a glance and
   * without relying on colour vision.
   */
  private drawBlock(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    tile: number,
    dissolve: number,
    tx: number,
    ty: number,
    soft: boolean,
    era?: EraPalette,
  ): void {
    if (dissolve >= 0.999) return;
    const face = soft ? (era ? era.soft : PAL.soft) : (era ? era.solid : PAL.solid);
    const top = soft ? (era ? era.softTop : PAL.softTop) : (era ? era.solidTop : PAL.solidTop);
    const edge = soft ? (era ? era.softEdge : PAL.softEdge) : (era ? era.solidEdge : PAL.solidEdge);

    if (dissolve > 0.001) {
      this.drawDissolved(g, px, py, tile, face, top, dissolve, tx, ty);
      return;
    }

    const lip = Math.max(2, tile * 0.18);
    // Soft blocks are rounded crates; hard blocks are near-square slabs.
    const r = soft ? Math.max(3, tile * 0.22) : Math.max(1, tile * 0.06);
    const inset = soft ? 2 : 1;

    g.save();
    g.fillStyle = face;
    roundRect(g, px + inset, py + inset, tile - inset * 2, tile - inset * 2, r);
    g.fill();
    g.fillStyle = top;
    roundRect(g, px + inset, py + inset, tile - inset * 2, lip, r);
    g.fill();

    if (soft) {
      // A hairline fracture running the full height, so the "hit me" read
      // survives greyscale and small screens. Kept asymmetric and thin so it
      // never resolves into an arrow or a glyph.
      g.strokeStyle = 'rgba(7,3,15,0.45)';
      g.lineWidth = Math.max(1, tile * 0.035);
      g.beginPath();
      g.moveTo(px + tile * 0.58, py + tile * 0.14);
      g.lineTo(px + tile * 0.44, py + tile * 0.4);
      g.lineTo(px + tile * 0.56, py + tile * 0.58);
      g.lineTo(px + tile * 0.36, py + tile * 0.86);
      g.moveTo(px + tile * 0.44, py + tile * 0.4);
      g.lineTo(px + tile * 0.24, py + tile * 0.5);
      g.stroke();
      g.strokeStyle = edge;
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(1, tile * 0.035);
      roundRect(g, px + inset + 1, py + inset + 1, tile - inset * 2 - 2, tile - inset * 2 - 2, r);
      g.stroke();
      g.globalAlpha = 1;
    } else {
      // Rivets read as "structural, permanent".
      g.fillStyle = edge;
      g.globalAlpha = 0.55;
      const rr = Math.max(1, tile * 0.045);
      for (const [ox, oy] of [
        [0.22, 0.3],
        [0.78, 0.3],
        [0.22, 0.78],
        [0.78, 0.78],
      ]) {
        g.beginPath();
        g.arc(px + tile * ox, py + tile * oy, rr, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    g.strokeStyle = 'rgba(7,3,15,0.75)';
    g.lineWidth = Math.max(1.2, tile * 0.06);
    roundRect(g, px + inset, py + inset, tile - inset * 2, tile - inset * 2, r);
    g.stroke();
    g.restore();
  }

  /** Sub-tile pixel eating. Deterministic, so a tile decays the same way twice. */
  private drawDissolved(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    tile: number,
    face: string,
    top: string,
    dissolve: number,
    tx: number,
    ty: number,
  ): void {
    const n = 4;
    const s = tile / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const hv = hash2(tx * n + i, ty * n + j);
        if (hv < dissolve) continue;
        g.fillStyle = j === 0 ? top : face;
        g.fillRect(px + i * s, py + j * s, s + 0.6, s + 0.6);
      }
    }
    // A single escaping bit drifts up out of each doomed tile.
    if (dissolve > 0.3 && dissolve < 0.9) {
      const hv = hash2(tx * 31, ty * 17);
      if (hv < dissolve) {
        g.fillStyle = PAL.magenta;
        g.globalAlpha = 0.55;
        g.fillRect(px + hv * tile, py - (dissolve * tile * 0.9 + hv * 5), s * 0.5, s * 0.5);
        g.globalAlpha = 1;
      }
    }
  }

  /** Reactor core: a pulsing node set into the wall. Bomb it. */
  private drawCore(g: CanvasRenderingContext2D, px: number, py: number, tile: number, t: number): void {
    const cx = px + tile / 2, cy = py + tile / 2;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    g.save();
    g.shadowColor = PAL.cyan;
    g.shadowBlur = tile * (0.4 + pulse * 0.5);
    g.fillStyle = '#07030f';
    g.beginPath();
    g.arc(cx, cy, tile * 0.34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = PAL.cyan;
    g.beginPath();
    g.arc(cx, cy, tile * (0.17 + pulse * 0.06), 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = PAL.ink;
    g.beginPath();
    g.arc(cx - tile * 0.05, cy - tile * 0.05, tile * 0.06, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  private drawGateBlock(


    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    tile: number,
    dissolve: number,
    tx: number,
    ty: number,
    time: number,
    isBoss?: boolean,
    era?: EraPalette,
  ): void {
    if (dissolve >= 0.999) return;
    const r = Math.max(2, tile * 0.1);
    g.fillStyle = isBoss ? '#200818' : (era ? era.gate : PAL.gate);
    roundRect(g, px + 1, py + 1, tile - 2, tile - 2, r);
    g.fill();

    const pulse = 0.55 + 0.45 * Math.sin(time * (isBoss ? 6 : 3) + tx * 0.6 + ty * 0.3);
    const edgeColor = isBoss ? PAL.magenta : (era ? era.gateEdge : PAL.gateEdge);
    g.strokeStyle = edgeColor;
    g.globalAlpha = 0.35 + pulse * (isBoss ? 0.6 : 0.4);
    g.lineWidth = Math.max(1.2, tile * (isBoss ? 0.09 : 0.06));
    roundRect(g, px + 2, py + 2, tile - 4, tile - 4, r);
    g.stroke();
    g.globalAlpha = 1;

    // Circuit / Boss hazard hatch
    g.strokeStyle = isBoss ? 'rgba(255,45,149,0.45)' : 'rgba(46,230,255,0.22)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px + tile * 0.25, py + tile * 0.5);
    g.lineTo(px + tile * 0.75, py + tile * 0.5);
    if (isBoss) {
      g.moveTo(px + tile * 0.5, py + tile * 0.25);
      g.lineTo(px + tile * 0.5, py + tile * 0.75);
    }
    g.stroke();
    void dissolve;
  }


  /** The exact 2D shape blueprint wireframe keyhole sockets for a Gate row. */
  private drawGateSockets(
    g: CanvasRenderingContext2D,
    gateRow: GateRow,
    cam: number,
    game: Game,
  ): void {
    if (!gateRow.sockets || gateRow.sockets.length === 0) return;
    const tile = this.layout.tile;
    const time = game.time;

    for (const socket of gateRow.sockets) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 4 + socket.startX);

      const isSeated = !!game.world.pieceInSocket(gateRow, socket);

      for (const [cx, cy] of socket.cells) {
        const sx = socket.startX + cx;
        const sy = gateRow.y + cy;
        const px = this.sx(sx);
        const py = this.sy(sy, cam);

        if (py < this.layout.boardY - tile * 2 || py > this.layout.boardY + this.layout.boardH + tile) continue;

        const cellOccupied = game.world.typeAt(sx, sy) === Cell.SHARD;
        if (cellOccupied) continue;

        g.save();
        // Blueprint background glow
        g.fillStyle = PAL.lime;
        g.globalAlpha = 0.05 + pulse * 0.04;
        g.fillRect(px + 2, py + 2, tile - 4, tile - 4);

        // Precision corner brackets
        g.strokeStyle = PAL.lime;
        g.globalAlpha = 0.4 + pulse * 0.35;
        g.lineWidth = Math.max(1.5, tile * 0.065);

        const bl = tile * 0.22;
        // Top-left bracket
        g.beginPath();
        g.moveTo(px + 3, py + 3 + bl);
        g.lineTo(px + 3, py + 3);
        g.lineTo(px + 3 + bl, py + 3);
        // Top-right bracket
        g.moveTo(px + tile - 3 - bl, py + 3);
        g.lineTo(px + tile - 3, py + 3);
        g.lineTo(px + tile - 3, py + 3 + bl);
        // Bottom-left bracket
        g.moveTo(px + 3, py + tile - 3 - bl);
        g.lineTo(px + 3, py + tile - 3);
        g.lineTo(px + 3 + bl, py + tile - 3);
        // Bottom-right bracket
        g.moveTo(px + tile - 3 - bl, py + tile - 3);
        g.lineTo(px + tile - 3, py + tile - 3);
        g.lineTo(px + tile - 3, py + tile - 3 - bl);
        g.stroke();

        // Blueprint alignment crosshair (+)
        g.strokeStyle = 'rgba(180,255,57,0.3)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(px + tile * 0.38, py + tile * 0.5);
        g.lineTo(px + tile * 0.62, py + tile * 0.5);
        g.moveTo(px + tile * 0.5, py + tile * 0.38);
        g.lineTo(px + tile * 0.5, py + tile * 0.62);
        g.stroke();

        g.restore();
      }

      // A filled socket is stamped later, once the Shards themselves have been
      // painted — drawn here it would end up underneath them.
      if (isSeated) continue;

      // Docking beacon under an empty socket.
      const bottomMidX = socket.startX + socket.width / 2;
      const px = this.sx(bottomMidX);
      const py = this.sy(gateRow.y, cam) + tile * 0.88;
      const arrowWob = Math.sin(time * 5 + socket.startX) * tile * 0.06;

      g.save();
      g.fillStyle = PAL.lime;
      g.shadowColor = PAL.lime;
      g.shadowBlur = tile * 0.3;
      g.globalAlpha = 0.55 + pulse * 0.45;
      g.font = `bold ${Math.round(tile * 0.34)}px ${DISPLAY}`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText('▲', px, py + arrowWob);
      g.restore();
    }
  }

  /**
   * Runs after the Shards are painted, so what it says about them lands on top
   * of them rather than under.
   */
  private drawGateStatus(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    const top = this.layout.boardY - tile * 2;
    const bottom = this.layout.boardY + this.layout.boardH + tile;

    for (const seg of game.world.segments) {
      if (seg.kind !== 'gate' || seg.open || !seg.rows) continue;
      for (const gateRow of seg.rows) {
        if (gateRow.cleared || !gateRow.sockets?.length) continue;
        const rowY = this.sy(gateRow.y, cam);
        if (rowY < top - tile * 4 || rowY > bottom + tile * 4) continue;

        for (const socket of gateRow.sockets) {
          const seated = !!game.world.pieceInSocket(gateRow, socket);
          if (!seated) continue;
          this.stampSeatedSocket(g, gateRow, socket, cam, game.time);
        }

        this.drawGateDemand(g, gateRow, cam, game);
      }
    }
  }

  /**
   * A filled socket has to read as finished at a glance, or a row that wants
   * two Shards looks exactly like a row that is simply refusing to open.
   */
  private stampSeatedSocket(
    g: CanvasRenderingContext2D,
    gateRow: GateRow,
    socket: GateSocket,
    cam: number,
    time: number,
  ): void {
    const tile = this.layout.tile;
    const pulse = 0.5 + 0.5 * Math.sin(time * 4 + socket.startX);

    g.save();
    g.strokeStyle = PAL.lime;
    g.shadowColor = PAL.lime;
    g.shadowBlur = tile * 0.35;
    g.globalAlpha = 0.7 + pulse * 0.3;
    g.lineWidth = Math.max(2, tile * 0.09);
    for (const [cx, cy] of socket.cells) {
      const px = this.sx(socket.startX + cx);
      const py = this.sy(gateRow.y + cy, cam);
      if (py < this.layout.boardY - tile * 2 || py > this.layout.boardY + this.layout.boardH + tile) continue;
      roundRect(g, px + 2, py + 2, tile - 4, tile - 4, tile * 0.14);
      g.stroke();
    }

    const stampY = this.sy(gateRow.y, cam);
    if (stampY >= this.layout.boardY - tile && stampY <= this.layout.boardY + this.layout.boardH) {
      const cx = this.sx(socket.startX + socket.width / 2);
      const cy = stampY + tile * 0.5;
      g.shadowBlur = tile * 0.4;
      g.globalAlpha = 0.9;
      g.fillStyle = 'rgba(7,3,15,0.75)';
      g.beginPath();
      g.arc(cx, cy, tile * 0.26, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = PAL.lime;
      g.font = `bold ${Math.round(tile * 0.34)}px ${DISPLAY}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('✓', cx, cy + 1);
    }
    g.restore();
  }

  /**
   * A Gate row only opens once every one of its sockets is filled, and a row
   * can want more than one Shard. Nothing said so: a player who seated one
   * correct Shard saw the wall stay shut with no hint that it was still owed
   * another, which reads as the gate being broken.
   */
  private drawGateDemand(
    g: CanvasRenderingContext2D,
    gateRow: GateRow,
    cam: number,
    game: Game,
  ): void {
    const sockets = gateRow.sockets;
    if (!sockets || sockets.length < 2) return;

    const tile = this.layout.tile;
    const filled = sockets.filter(socket => game.world.pieceInSocket(gateRow, socket)).length;

    const rowY = this.sy(gateRow.y, cam);
    const py = rowY + tile * 1.75;
    if (py < this.layout.boardY - tile || py > this.layout.boardY + this.layout.boardH + tile) return;

    // No "ready" state: the row clears on the same tick its last socket fills,
    // and the update runs before the draw, so it would never be seen.
    const label = `${filled} / ${sockets.length} SHARDS SEATED`;
    const tint = PAL.amber;
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 4);

    g.save();
    g.font = `bold ${Math.round(tile * 0.3)}px ${DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const cx = this.layout.boardX + this.layout.boardW / 2;
    const padX = tile * 0.42;
    const w = g.measureText(label).width + padX * 2;
    const h = tile * 0.62;

    g.globalAlpha = 0.82;
    g.fillStyle = 'rgba(7,3,15,0.9)';
    roundRect(g, cx - w / 2, py - h / 2, w, h, h * 0.4);
    g.fill();

    g.globalAlpha = 0.7 + pulse * 0.3;
    g.strokeStyle = tint;
    g.lineWidth = Math.max(1.5, tile * 0.05);
    roundRect(g, cx - w / 2, py - h / 2, w, h, h * 0.4);
    g.stroke();

    g.globalAlpha = 1;
    g.fillStyle = tint;
    g.shadowColor = tint;
    g.shadowBlur = tile * 0.3;
    g.fillText(label, cx, py + 1);
    g.restore();
  }

  /** The empty notch in a Gate row that a Shard has to fill. */
  private drawSlot(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    tile: number,
    time: number,
  ): void {
    const pulse = 0.5 + 0.5 * Math.sin(time * 5);
    g.save();
    g.strokeStyle = PAL.lime;
    g.globalAlpha = 0.35 + pulse * 0.45;
    g.lineWidth = Math.max(1.5, tile * 0.07);
    g.setLineDash([tile * 0.18, tile * 0.14]);
    roundRect(g, px + 3, py + 3, tile - 6, tile - 6, tile * 0.12);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.10 + pulse * 0.08;
    g.fillStyle = PAL.lime;
    g.fillRect(px + 2, py + 2, tile - 4, tile - 4);
    g.restore();
  }

  private drawPickup(
    g: CanvasRenderingContext2D,
    px: number,
    py: number,
    tile: number,
    kind: number,
    time: number,
  ): void {
    const bob = Math.sin(time * 4 + px * 0.05) * tile * 0.06;
    const cx = px + tile / 2;
    const cy = py + tile / 2 + bob;
    const color =
      kind === PickupKind.FIRE ? PAL.orange
        : kind === PickupKind.BOMB ? PAL.amber
          : kind === PickupKind.SPEED ? PAL.cyan
            : kind === PickupKind.SHIELD ? PAL.lime
              : kind === PickupKind.KICK ? PAL.ink
                : kind === PickupKind.SLIDE ? PAL.ink
                  : kind === PickupKind.MAGNET ? PAL.cyan
                    : kind === PickupKind.LIFT ? PAL.lime
                    : kind === PickupKind.PIERCE ? PAL.orange
                    : kind === PickupKind.ROLLBACK ? PAL.magenta
                      : kind === PickupKind.FREEZE ? PAL.violet
                        : PAL.amber;

    g.save();
    g.shadowColor = color;
    g.shadowBlur = tile * 0.5;
    g.fillStyle = 'rgba(7,3,15,0.85)';
    roundRect(g, cx - tile * 0.34, cy - tile * 0.34, tile * 0.68, tile * 0.68, tile * 0.16);
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.5, tile * 0.07);
    roundRect(g, cx - tile * 0.34, cy - tile * 0.34, tile * 0.68, tile * 0.68, tile * 0.16);
    g.stroke();

    g.fillStyle = color;
    g.font = `${Math.round(tile * 0.42)}px ${DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const glyph =
      kind === PickupKind.FIRE ? '✸'
        : kind === PickupKind.BOMB ? '✦'
          : kind === PickupKind.SPEED ? '»'
            : kind === PickupKind.SHIELD ? '⬡'
              : kind === PickupKind.KICK ? '⇒'
                : kind === PickupKind.SLIDE ? '⇶'
                  : kind === PickupKind.MAGNET ? '⊂'
                    : kind === PickupKind.LIFT ? '↥'
                    : kind === PickupKind.PIERCE ? '⌖'
                    : kind === PickupKind.ROLLBACK ? '↯'
                      : kind === PickupKind.FREEZE ? '❄'
                        : '⇧';
    g.fillText(glyph, cx, cy + 1);
    g.restore();
  }

  // --------------------------------------------------------------- shards

  private drawShards(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const L = this.layout;
    for (const piece of game.world.pieces.values()) {
      const [c0, c1] = SHARD_COLORS[piece.hue % SHARD_COLORS.length];
      const glyph = SHARD_GLYPHS[piece.hue % SHARD_GLYPHS.length];
      const own = new Set(piece.cells.map((c) => `${c.x},${c.y}`));

      for (const c of piece.cells) {
        const px = this.sx(c.x + piece.ox);
        const py = this.sy(c.y + piece.oy, cam);
        if (py < L.boardY - L.tile * 2 || py > L.boardY + L.boardH + L.tile) continue;

        const dissolve = this.dissolveAmount(game, c.y);
        if (dissolve >= 0.999) continue;

        g.save();
        g.globalAlpha = 1 - dissolve * 0.8;
        g.fillStyle = c1;
        g.fillRect(px, py, L.tile, L.tile);
        g.fillStyle = c0;
        g.fillRect(px + L.tile * 0.06, py + L.tile * 0.06, L.tile * 0.88, L.tile * 0.6);

        // Only outline the silhouette edges, so a shard reads as one solid
        // object rather than a pile of loose tiles.
        g.strokeStyle = 'rgba(7,3,15,0.9)';
        g.lineWidth = Math.max(2, L.tile * 0.09);
        g.beginPath();
        if (!own.has(`${c.x},${c.y + 1}`)) {
          g.moveTo(px, py);
          g.lineTo(px + L.tile, py);
        }
        if (!own.has(`${c.x},${c.y - 1}`)) {
          g.moveTo(px, py + L.tile);
          g.lineTo(px + L.tile, py + L.tile);
        }
        if (!own.has(`${c.x - 1},${c.y}`)) {
          g.moveTo(px, py);
          g.lineTo(px, py + L.tile);
        }
        if (!own.has(`${c.x + 1},${c.y}`)) {
          g.moveTo(px + L.tile, py);
          g.lineTo(px + L.tile, py + L.tile);
        }
        g.stroke();

        g.fillStyle = 'rgba(7,3,15,0.55)';
        g.font = `${Math.round(L.tile * 0.4)}px ${DISPLAY}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(glyph, px + L.tile / 2, py + L.tile / 2);

        // A seated shard gets the slot's own colour, so "it's in" is instant.
        if (piece.locked && game.world.isSealed(c.y)) {
          g.strokeStyle = PAL.lime;
          g.lineWidth = Math.max(2, L.tile * 0.09);
          g.globalAlpha = 0.85;
          g.strokeRect(px + 2, py + 2, L.tile - 4, L.tile - 4);
        }
        g.restore();
      }
    }
  }

  // ------------------------------------------------------------ actors, fx

  private drawBombs(g: CanvasRenderingContext2D, game: Game, cam: number, alpha: number): void {
    const tile = this.layout.tile;
    for (const b of game.bombs) {
      const carrier = b.carriedBy === undefined ? undefined : game.players[b.carriedBy];
      const flightT = b.flight ? 1 - Math.max(0, b.flight.remaining / BOMB_THROW_SECONDS) : 1;
      const bx = carrier ? carrier.rx : b.flight ? b.flight.fromX + (b.x - b.flight.fromX) * flightT : b.x;
      const by = carrier ? carrier.ry : b.flight ? b.flight.fromY + (b.y - b.flight.fromY) * flightT : b.y;
      const arc = carrier ? 0.85 : b.flight ? Math.sin(flightT * Math.PI) * 1.8 : 0;
      const targetX = bx + (b.ox ?? 0), targetY = by + (b.oy ?? 0);
      const interpolate = !carrier && !b.flight;
      const renderX = interpolate ? (b.previousX ?? targetX) + (targetX - (b.previousX ?? targetX)) * alpha : targetX;
      const renderY = interpolate ? (b.previousY ?? targetY) + (targetY - (b.previousY ?? targetY)) * alpha : targetY;
      const px = this.sx(renderX) + tile / 2;
      const py = this.sy(renderY, cam) + tile / 2 - arc * tile;
      const urgency = Math.max(0, Math.min(1, 1 - b.fuse / BOMB_FUSE));
      const beat = carrier ? 1 : 1 + Math.sin(game.time * (14 + urgency * 25)) * 0.09 * (1 + urgency * 2.1);
      const r = tile * 0.34 * beat;

      g.save();
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.beginPath();
      g.ellipse(px, py + tile * 0.3, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
      g.fill();

      // Last half-second: the shell strobes hot and a warning ring closes in.
      const critical = !carrier && !b.flight && b.fuse < 0.5;
      const strobe = critical && Math.floor(game.time * 24) % 2 === 0;
      if (critical) {
        g.strokeStyle = PAL.amber;
        g.globalAlpha = 0.35 + (1 - b.fuse / 0.5) * 0.5;
        g.lineWidth = Math.max(1.5, tile * 0.05);
        g.beginPath();
        g.arc(px, py, r + tile * 0.55 * (b.fuse / 0.5), 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
      g.fillStyle = strobe ? PAL.orange : '#140a24';
      g.strokeStyle = PAL.ink;
      g.lineWidth = Math.max(2, tile * 0.07);
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();

      g.fillStyle = 'rgba(255,246,255,0.75)';
      g.beginPath();
      g.arc(px - r * 0.32, py - r * 0.34, r * 0.2, 0, Math.PI * 2);
      g.fill();

      // A steady cyan pause mark replaces the burning fuse while carried.
      if (carrier) {
        g.fillStyle = PAL.cyan;
        g.fillRect(px - r * 0.3, py - r * 0.25, r * 0.2, r * 0.6);
        g.fillRect(px + r * 0.1, py - r * 0.25, r * 0.2, r * 0.6);
        g.restore();
        continue;
      }
      // Fuse spark, brighter as the fuse runs out.
      const sparkR = tile * (0.09 + urgency * 0.09);
      g.fillStyle = b.fuse < 0.6 ? PAL.ink : PAL.amber;
      g.shadowColor = PAL.orange;
      g.shadowBlur = tile * 0.5;
      g.beginPath();
      g.arc(px + r * 0.55, py - r * 0.9, sparkR, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  private drawFlames(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const f of game.flames) {
      const k = f.life / f.max;
      const px = this.sx(f.x);
      const py = this.sy(f.y, cam);
      const layers = 4;
      for (let i = 0; i < layers; i++) {
        // The outermost layer fills the whole tile with no inset, so adjacent
        // flame tiles merge into one continuous blast cross instead of a row
        // of separate blobs.
        const inset = tile * (i * 0.13) * (1 + (1 - k) * 0.7);
        g.globalAlpha = k * (0.3 + i * 0.17);
        g.fillStyle = FLAME_COLORS[Math.min(FLAME_COLORS.length - 1, layers - 1 - i)];
        roundRect(g, px + inset, py + inset, tile - inset * 2, tile - inset * 2, tile * 0.22);
        g.fill();
      }
    }
    g.restore();
  }

  private drawEnemies(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    for (const e of game.enemies) {
      const px = this.sx(e.rx) + tile / 2;
      const py = this.sy(e.ry, cam) + tile / 2;
      const wob = Math.sin(game.time * 9 + e.gx) * tile * 0.05;
      const stunShake = e.stun > 0 ? (Math.random() - 0.5) * tile * 0.1 : 0;
      const panicShake = e.panic > 0 ? (Math.random() - 0.5) * tile * 0.18 : 0;

      let color: string = PAL.violet;
      if (e.variant === 1) color = PAL.magenta; // Hunter
      else if (e.variant === 2) color = PAL.cyan; // Glitcher
      else if (e.variant === 3) color = PAL.amber; // Warden


      g.save();
      g.translate(stunShake + panicShake, 0);

      // Contact shadow
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.beginPath();
      g.ellipse(px, py + tile * 0.34, tile * (e.variant === 3 ? 0.35 : 0.28), tile * 0.11, 0, 0, Math.PI * 2);
      g.fill();

      // Glitcher extra glitch drift
      if (e.variant === 2) {
        g.fillStyle = 'rgba(33,230,255,0.4)';
        const gx = (Math.random() - 0.5) * tile * 0.5;
        const gy = (Math.random() - 0.5) * tile * 0.5;
        g.fillRect(px + gx - 2, py + gy - 2, 4, 4);
      }

      g.fillStyle = color;
      g.strokeStyle = '#07030f';
      g.lineWidth = Math.max(2, tile * (e.variant === 3 ? 0.1 : 0.08));
      g.beginPath();

      if (e.variant === 1) {
        // Hunter: Sharp horns
        g.moveTo(px - tile * 0.3, py + tile * 0.26 + wob);
        g.lineTo(px - tile * 0.32, py - tile * 0.08);
        g.lineTo(px - tile * 0.18, py - tile * 0.24); // horn left
        g.lineTo(px - tile * 0.08, py - tile * 0.08);
        g.lineTo(px + tile * 0.08, py - tile * 0.08);
        g.lineTo(px + tile * 0.18, py - tile * 0.24); // horn right
        g.lineTo(px + tile * 0.32, py - tile * 0.08);
        g.lineTo(px + tile * 0.3, py + tile * 0.26 + wob);
        for (let i = 0; i < 3; i++) {
          g.lineTo(px + tile * (0.2 - i * 0.2), py + tile * (i % 2 ? 0.26 : 0.12) + wob);
        }
      } else if (e.variant === 3) {
        // Warden: Heavy armored square shell
        roundRect(g, px - tile * 0.34, py - tile * 0.32 + wob, tile * 0.68, tile * 0.64, tile * 0.14);
      } else {
        // Drifter / Glitcher: Dome + skirt
        g.moveTo(px - tile * 0.3, py + tile * 0.26 + wob);
        g.lineTo(px - tile * 0.3, py - tile * 0.04);
        g.arc(px, py - tile * 0.04, tile * 0.3, Math.PI, 0);
        g.lineTo(px + tile * 0.3, py + tile * 0.26 + wob);
        for (let i = 0; i < 3; i++) {
          g.lineTo(px + tile * (0.2 - i * 0.2), py + tile * (i % 2 ? 0.26 : 0.12) + wob);
        }
      }
      g.closePath();
      g.fill();
      g.stroke();

      // Warden armor rivets / cracked state
      if (e.variant === 3) {
        g.fillStyle = e.hp > 1 ? '#fff6ff' : PAL.magenta;
        g.fillRect(px - tile * 0.2, py - tile * 0.18 + wob, tile * 0.4, tile * 0.08);
        if (e.hp > 1) {
          // Shield aura ring
          g.strokeStyle = PAL.amber;
          g.lineWidth = 1.5;
          g.strokeRect(px - tile * 0.38, py - tile * 0.36 + wob, tile * 0.76, tile * 0.72);
        }
      } else {
        // Eyes
        g.fillStyle = '#07030f';
        g.beginPath();
        g.arc(px - tile * 0.11, py - tile * 0.06, tile * 0.06, 0, Math.PI * 2);
        g.arc(px + tile * 0.11, py - tile * 0.06, tile * 0.06, 0, Math.PI * 2);
        g.fill();
      }

      // Glitcher panic reaction telegraph mark (Phase 1 Setup)
      if (e.variant === 2 && e.panic > 0) {
        g.save();
        g.fillStyle = PAL.amber;
        g.shadowColor = PAL.orange;
        g.shadowBlur = tile * 0.4;
        g.font = `bold ${Math.round(tile * 0.42)}px ${DISPLAY}`;
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        g.fillText('!', px, py - tile * 0.34 + wob);
        g.restore();
      }

      g.restore();
    }
  }


  private drawPlayers(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    for (const p of game.players) {
      if (p.down) continue;
      const px = this.sx(p.rx) + tile / 2;
      const py = this.sy(p.ry, cam) + tile / 2;
      const color = PLAYER_COLORS[p.index];
      const dark = PLAYER_DARK[p.index];
      const blink = p.iframes > 0 && Math.floor(game.time * 18) % 2 === 0;
      const bob = Math.sin(game.time * 10) * (p.moving ? tile * 0.05 : tile * 0.02);

      g.save();
      g.globalAlpha = blink ? 0.4 : 1;

      // Contact shadow first, so the runner sits *in* the shaft.
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.beginPath();
      g.ellipse(px, py + tile * 0.38, tile * 0.3, tile * 0.1, 0, 0, Math.PI * 2);
      g.fill();

      // Identity ring on the floor. P2's is larger, so the two players are
      // told apart by size as well as hue.
      g.strokeStyle = color;
      g.lineWidth = Math.max(2, tile * 0.07);
      g.globalAlpha = (blink ? 0.25 : 0.7) + Math.sin(game.time * 4) * 0.12;
      g.beginPath();
      g.ellipse(px, py + tile * 0.38, tile * (0.31 + p.index * 0.06), tile * 0.12, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = blink ? 0.4 : 1;

      // The runner is the brightest object on screen, full stop.
      g.shadowColor = color;
      g.shadowBlur = tile * 0.55;
      g.fillStyle = color;
      g.strokeStyle = '#07030f';
      g.lineWidth = Math.max(2.5, tile * 0.11);
      g.lineJoin = 'round';
      const bx = px - tile * 0.3;
      const by = py - tile * 0.36 + bob;
      roundRect(g, bx, by, tile * 0.6, tile * 0.68, tile * 0.26);
      g.fill();
      g.shadowBlur = 0;
      g.stroke();

      // Lower body in the darker tone: gives the silhouette a waist.
      g.fillStyle = dark;
      g.beginPath();
      g.rect(bx + tile * 0.04, by + tile * 0.44, tile * 0.52, tile * 0.2);
      g.fill();

      // Visor leans the way you are walking — this is the whole read of intent.
      const lean = p.facing.x * tile * 0.07;
      g.fillStyle = '#07030f';
      roundRect(g, px - tile * 0.21 + lean, py - tile * 0.22 + bob, tile * 0.42, tile * 0.2, tile * 0.09);
      g.fill();
      g.fillStyle = PAL.ink;
      g.fillRect(px - tile * 0.15 + lean, py - tile * 0.19 + bob, tile * 0.12, tile * 0.08);
      g.fillStyle = color;
      g.fillRect(px + tile * 0.06 + lean, py - tile * 0.19 + bob, tile * 0.07, tile * 0.08);

      // Antenna spark: tiny, but it makes the character feel alive at 24px.
      g.strokeStyle = '#07030f';
      g.lineWidth = Math.max(1.5, tile * 0.05);
      g.beginPath();
      g.moveTo(px, by);
      g.lineTo(px + tile * 0.06, by - tile * 0.16);
      g.stroke();
      g.fillStyle = p.shield > 0 ? PAL.lime : PAL.amber;
      g.beginPath();
      g.arc(px + tile * 0.06, by - tile * 0.18, tile * 0.06, 0, Math.PI * 2);
      g.fill();

      if (p.shield > 0) {
        g.globalAlpha = 0.45 + Math.sin(game.time * 8) * 0.2;
        g.strokeStyle = PAL.lime;
        g.lineWidth = Math.max(2, tile * 0.06);
        g.beginPath();
        g.arc(px, py, tile * 0.48, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }
  }

  private drawVoid(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const L = this.layout;
    const lineY = this.sy(game.voidY, cam) + L.tile;
    if (lineY < L.boardY - L.tile) return;

    const top = Math.max(L.boardY, lineY);
    g.save();
    g.fillStyle = PAL.void;
    g.fillRect(L.boardX, top, L.boardW, L.boardY + L.boardH - top);

    // Glitch scanlines crawling in the deleted space.
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const seed = hash2(i, Math.floor(game.time * 7));
      const y = top + seed * Math.max(1, L.boardY + L.boardH - top);
      g.globalAlpha = 0.05 + seed * 0.18;
      g.fillStyle = i % 2 ? PAL.magenta : PAL.cyan;
      g.fillRect(L.boardX + seed * 8, y, L.boardW - seed * 12, 1 + seed * 2.5);
    }
    g.globalCompositeOperation = 'source-over';

    // The event horizon itself: a torn, glowing edge.
    const edge = g.createLinearGradient(0, lineY - L.tile * 1.6, 0, lineY + L.tile * 0.4);
    edge.addColorStop(0, 'rgba(255,45,149,0)');
    edge.addColorStop(0.7, 'rgba(255,45,149,0.5)');
    edge.addColorStop(1, 'rgba(155,92,255,0.85)');
    g.fillStyle = edge;
    g.fillRect(L.boardX, lineY - L.tile * 1.6, L.boardW, L.tile * 2);

    g.strokeStyle = PAL.magenta;
    g.lineWidth = Math.max(2, L.tile * 0.09);
    g.shadowColor = PAL.magenta;
    g.shadowBlur = L.tile * 0.9;
    g.beginPath();
    const teeth = COLS * 3;
    for (let i = 0; i <= teeth; i++) {
      const x = L.boardX + (i / teeth) * L.boardW;
      const n = hash2(i, Math.floor(game.time * 12));
      const y = lineY + (n - 0.5) * L.tile * 0.5;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.restore();
  }

  /** End-of-run tide: the Void's colour rises up the board before results. */
  private drawVoidWash(g: CanvasRenderingContext2D): void {
    const L = this.layout;
    const k = Math.min(1, this.overT / 0.9);
    const top = L.boardY + L.boardH * (1 - k * 1.1);
    const wash = g.createLinearGradient(0, top, 0, L.boardY + L.boardH);
    wash.addColorStop(0, 'rgba(255,45,149,0)');
    wash.addColorStop(0.25, `rgba(155,92,255,${0.35 * k})`);
    wash.addColorStop(1, `rgba(7,3,15,${0.85 * k})`);
    g.save();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = wash;
    g.fillRect(L.boardX, top, L.boardW, L.boardY + L.boardH - top);
    g.restore();
  }

  private drawParticles(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    g.save();
    for (const p of game.fx.particles) {
      const a = p.life / p.max;
      g.globalAlpha = Math.min(1, a * 1.6);
      g.fillStyle = p.color;
      g.save();
      g.translate(this.sx(p.x), this.sy(p.y, cam) + tile);
      g.rotate(p.rot);
      const s = p.size * tile;
      g.fillRect(-s / 2, -s / 2, s, s * 0.72);
      g.restore();
    }
    g.restore();
  }

  private drawTexts(g: CanvasRenderingContext2D, game: Game, cam: number): void {
    const tile = this.layout.tile;
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const t of game.fx.texts) {
      const k = t.life / t.max;
      const pop = k > 0.8 ? 1 + (1 - k) * 5 : 1 + Math.max(0, k - 0.2) * 0.12;
      const size = tile * (t.weight ? 0.62 : 0.34) * Math.min(1.25, pop);
      g.save();
      g.translate(this.sx(t.x), this.sy(t.y, cam) + tile);
      g.rotate(t.rot);
      g.globalAlpha = Math.min(1, k * 2.2);
      g.font = `${Math.round(size)}px ${t.weight ? DISPLAY : UI}`;

      if (t.weight) {
        // Comic-panel lettering: a hard colour drop behind a heavy ink
        // outline, filled white. White on ink survives any board colour —
        // filling with the accent alone muddies against the dark tiles.
        g.fillStyle = t.color;
        g.fillText(t.text, size * 0.09, size * 0.1);
        g.lineWidth = size * 0.22;
        g.strokeStyle = '#07030f';
        g.lineJoin = 'round';
        g.miterLimit = 2;
        g.strokeText(t.text, 0, 0);
        g.fillStyle = PAL.ink;
        g.fillText(t.text, 0, 0);
      } else {
        g.lineWidth = size * 0.34;
        g.strokeStyle = 'rgba(7,3,15,0.85)';
        g.lineJoin = 'round';
        g.strokeText(t.text, 0, 0);
        g.fillStyle = t.color;
        g.fillText(t.text, 0, 0);
      }
      g.restore();
    }
    g.restore();
  }

  private drawBoardFrame(g: CanvasRenderingContext2D): void {
    const L = this.layout;
    g.save();
    g.strokeStyle = 'rgba(155,92,255,0.5)';
    g.lineWidth = 2;
    g.strokeRect(L.boardX + 1, L.boardY + 1, L.boardW - 2, L.boardH - 2);
    g.restore();
  }

  private drawGrain(g: CanvasRenderingContext2D): void {
    if (!this.halftone) return;
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.fillStyle = this.halftone;
    g.fillRect(0, 0, this.w, this.h);
    g.restore();
  }

  private drawVignette(c: CanvasRenderingContext2D, danger: number, time: number): void {
    const r = Math.hypot(this.w, this.h) * 0.62;
    const v = c.createRadialGradient(this.w / 2, this.h / 2, r * 0.35, this.w / 2, this.h / 2, r);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${0.55 + danger * 0.2})`);
    c.fillStyle = v;
    c.fillRect(0, 0, this.w, this.h);

    if (danger > 0.05) {
      const d = danger;
      const p = c.createRadialGradient(this.w / 2, this.h / 2, r * 0.3, this.w / 2, this.h / 2, r);
      p.addColorStop(0, 'rgba(255,45,149,0)');
      p.addColorStop(1, `rgba(255,45,149,${0.42 * d * (0.7 + 0.3 * Math.sin(time * 9))})`);
      c.fillStyle = p;
      c.fillRect(0, 0, this.w, this.h);
    }
  }

  // ------------------------------------------------------------------- HUD

  private drawHud(game: Game): void {
    const c = this.ctx;
    const L = this.layout;
    c.save();
    c.textBaseline = 'top';

    if (L.stacked) {
      this.drawHudBar(c, game);
      this.drawThumbBand(c, game);
    } else {
      this.drawHudRail(c, game);
      if (L.railW) this.drawLeftRail(c, game);
    }

    c.restore();
  }

  private drawHudRail(c: CanvasRenderingContext2D, game: Game): void {
    const L = this.layout;
    let y = L.hudY;
    const x = L.hudX;
    const w = L.hudW;

    c.textAlign = 'left';
    c.fillStyle = PAL.ink;
    c.font = `${Math.round(Math.min(46, w * 0.2))}px ${DISPLAY}`;
    c.fillText('BOM', x, y);
    c.fillStyle = PAL.magenta;
    c.fillText('BAZ', x + c.measureText('BOM').width, y);
    y += Math.min(46, w * 0.2) * 1.15;

    const era = getEraPalette(game.chapter);
    c.font = `600 11px ${UI}`;
    c.fillStyle = 'rgba(255,246,255,0.45)';
    c.fillText(`SECTOR ${String(game.chapter + 1).padStart(2, '0')}  ·  ${game.mode.toUpperCase()}`, x, y);
    y += 16;
    c.font = `700 9px ${UI}`;
    c.fillStyle = era.gateEdge;
    c.fillText(era.name, x, y);
    y += 18;

    y = this.statBlock(c, x, y, w, 'SCORE', Math.floor(this.shownScore).toLocaleString(), PAL.ink);
    y = this.statBlock(c, x, y, w, 'ALTITUDE', `${Math.max(0, Math.floor(game.bestDepth))} m`, PAL.cyan);
    y = this.statBlock(c, x, y, w, 'LINES', String(game.linesCleared), PAL.lime);
    y = this.statBlock(c, x, y, w, 'CHIPS', `+${game.earnedChips} (${storage.getChips()})`, PAL.amber);

    y += 4;
    y = this.voidMeter(c, x, y, w, game);

    const effects = [
      game.voidFreezeTimer > 0 ? `VOID FREEZE ${Math.ceil(game.voidFreezeTimer)}s` : '',
      game.pushDriveTimer > 0 ? `PUSH DRIVE ${Math.ceil(game.pushDriveTimer)}s` : '',
    ].filter(Boolean);
    if (effects.length) {
      c.fillStyle = PAL.cyan;
      c.font = `700 10px ${UI}`;
      c.fillText(effects.join(' · '), x, y);
      y += 16;
    }

    y += 8;
    if (!L.railW) {
      for (const p of game.players) y = this.playerCard(c, x, y, w, game, p.index);
    }

    const gate = game.world.nextGate(game.leadY - 2);
    if (gate?.rows) {
      const coreRow = gate.rows.find((r) => !r.cleared && r.cores);
      const cores = coreRow?.cores?.filter((cx) => game.world.typeAt(cx, coreRow.y) === Cell.CORE).length ?? 0;
      const remaining = coreRow ? cores : gate.rows.filter((r) => !r.cleared).length;
      const unit = coreRow ? 'CORE' : 'LINE';
      c.fillStyle = gate.isBoss ? PAL.magenta : 'rgba(255,246,255,0.4)';
      c.font = `700 11px ${UI}`;
      c.fillText(gate.isBoss ? 'BOSS GATE' : 'NEXT GATE', x, y + 8);
      const lineSize = Math.round(w * 0.13);
      c.fillStyle = gate.isBoss ? PAL.magenta : PAL.lime;
      c.font = `${lineSize}px ${DISPLAY}`;
      c.fillText(`${remaining} ${unit}${remaining > 1 ? 'S' : ''}`, x, y + 24);

      // Spell out what the next line is still owed. A row wanting two Shards
      // is the one case where a correct Shard leaves the wall shut anyway.
      const next = gate.rows.find((r) => !r.cleared);
      const sockets = next?.sockets ?? [];
      if (next && sockets.length > 1) {
        const short = sockets.filter(
          (socket) => !game.world.pieceInSocket(next, socket),
        ).length;
        // short is never 0 here: a fully seated row clears before this draws.
        c.fillStyle = PAL.amber;
        c.font = `700 11px ${UI}`;
        c.fillText(`NEEDS ${short} MORE SHARD${short > 1 ? 'S' : ''}`, x, y + 24 + lineSize * 0.85);
      }
    }

  }

  /** Left rail: who you are and what you are holding. */
  private drawLeftRail(c: CanvasRenderingContext2D, game: Game): void {
    const L = this.layout;
    const x = L.railX;
    const w = L.railW;
    let y = L.hudY;

    c.textAlign = 'left';
    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText('RUNNERS', x, y);
    y += 16;
    for (const p of game.players) y = this.playerCard(c, x, y, w, game, p.index);

    if (game.combo > 1) {
      c.fillStyle = PAL.lime;
      c.font = `${Math.round(w * 0.18)}px ${DISPLAY}`;
      c.fillText(`${game.combo}x`, x, y + 6);
      c.fillStyle = 'rgba(255,246,255,0.45)';
      c.font = `600 10px ${UI}`;
      c.fillText('CHAIN', x + w * 0.19 + 8, y + w * 0.1);
      y += w * 0.2 + 10;
    }

    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText('COMBO BATTERY', x, y + 6);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(c, x, y + 20, w, 7, 4);
    c.fill();
    c.fillStyle = PAL.cyan;
    roundRect(c, x, y + 20, w * (game.comboBattery / 100), 7, 4);
    c.fill();
    y += 38;

    // Controls, so a first-time player never has to leave the board to learn
    // the single button.
    y += 6;
    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText('CONTROLS', x, y);
    y += 16;
    const prompts: Array<[string, string]> =
      game.players.length > 1
        ? [
            ['P1', 'WASD  ·  SPACE'],
            ['P2', 'IJKL  ·  R-SHIFT'],
            ['PAD', 'STICK  ·  ANY BUTTON'],
          ]
        : [
            ['MOVE', 'WASD / ARROWS / STICK'],
            ['ACTION', 'SPACE / ANY BUTTON'],
            ['PAUSE', 'ESC / START'],
          ];
    for (const [k, v] of prompts) {
      c.fillStyle = 'rgba(255,246,255,0.75)';
      c.font = `700 10px ${UI}`;
      c.fillText(k, x, y);
      c.fillStyle = 'rgba(255,246,255,0.35)';
      c.font = `500 10px ${UI}`;
      c.fillText(v, x + 46, y);
      y += 15;
    }

    // Legend. New players need to know what is breakable before they die.
    y = L.hudY + L.hudH - 118;
    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText('LEGEND', x, y);
    y += 16;
    const swatch = 14;
    const era = getEraPalette(game.chapter);
    const rows: Array<[string, string, string]> = [
      [era.softTop, 'BRICK', 'blast it'],
      [era.solidTop, 'PILLAR', 'permanent'],
      [PAL.cyan, 'CORE', 'bomb it'],
      [era.gateEdge, 'GATE', 'breaks when cores are down'],
    ];
    for (const [col, label, note] of rows) {
      c.fillStyle = col;
      roundRect(c, x, y, swatch, swatch, 3);
      c.fill();
      c.fillStyle = 'rgba(255,246,255,0.8)';
      c.font = `700 10px ${UI}`;
      c.fillText(label, x + swatch + 8, y + 1);
      c.fillStyle = 'rgba(255,246,255,0.35)';
      c.font = `500 10px ${UI}`;
      c.fillText(note, x + swatch + 8 + 46, y + 1);
      y += swatch + 6;
    }
  }

  private statBlock(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    label: string,
    value: string,
    color: string,
  ): number {
    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText(label, x, y);
    c.fillStyle = color;
    c.font = `${Math.round(Math.min(34, w * 0.17))}px ${DISPLAY}`;
    c.fillText(value, x, y + 13);
    return y + 13 + Math.min(34, w * 0.17) + 10;
  }

  private voidMeter(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    game: Game,
  ): number {
    const h = 10;
    const d = game.danger;
    c.fillStyle = 'rgba(255,246,255,0.4)';
    c.font = `600 10px ${UI}`;
    c.fillText('VOID PROXIMITY', x, y);
    y += 14;
    c.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(c, x, y, w, h, h / 2);
    c.fill();
    const grad = c.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, PAL.violet);
    grad.addColorStop(1, PAL.magenta);
    c.fillStyle = grad;
    roundRect(c, x, y, Math.max(h, w * d), h, h / 2);
    c.fill();
    if (d > 0.65) {
      c.globalAlpha = 0.4 + Math.sin(game.time * 12) * 0.3;
      c.fillStyle = PAL.ink;
      roundRect(c, x, y, Math.max(h, w * d), h, h / 2);
      c.fill();
      c.globalAlpha = 1;
    }
    return y + h + 12;
  }

  private playerCard(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    game: Game,
    idx: number,
  ): number {
    const p = game.players[idx];
    const color = PLAYER_COLORS[idx];
    const tags = [
      p.lift ? 'LIFT' : p.slide ? 'SLIDE' : p.kick ? 'KICK' : '',
      p.magnet ? 'MAGNET' : '',
      p.pierce ? 'PIERCE' : '',
      p.shield > 0 ? `SHIELD ${p.shield}` : '',
    ].filter(Boolean);
    const tagRows = Math.ceil(tags.length / 2);
    const h = 46 + tagRows * 14;
    c.fillStyle = 'rgba(255,255,255,0.04)';
    roundRect(c, x, y, w, h, 10);
    c.fill();
    c.strokeStyle = p.down ? 'rgba(255,45,149,0.6)' : `${color}66`;
    c.lineWidth = 1.5;
    roundRect(c, x, y, w, h, 10);
    c.stroke();

    c.fillStyle = p.down ? PAL.magenta : color;
    c.font = `600 10px ${UI}`;
    c.fillText(p.down ? `P${idx + 1} · DELETED` : `P${idx + 1}`, x + 10, y + 8);

    const px = x + 10;
    const py = y + 24;
    c.font = `700 11px ${UI}`;
    c.fillStyle = PAL.amber;
    c.fillText(`BOMBS ${p.bombs}`, px, py + 4);
    c.fillStyle = PAL.orange;
    c.fillText(`BLAST ${p.power}`, px + w * 0.46, py + 4);

    // Keep owned tools visible alongside the uncapped numeric stats; a run needs a
    // way to answer "do I already have Kick?" — which is exactly the question
    // that makes a duplicate pickup feel wasted.
    if (tags.length) {
      c.font = `700 9px ${UI}`;
      c.fillStyle = p.down ? 'rgba(255,246,255,0.3)' : `${color}cc`;
      for (let row = 0; row < tagRows; row++) {
        c.fillText(tags.slice(row * 2, row * 2 + 2).join('  ·  '), px, py + 18 + row * 14);
      }
    }
    return y + h + 8;
  }


  private drawThumbBand(c: CanvasRenderingContext2D, game: Game): void {
    const L = this.layout;
    const top = L.boardY + L.boardH;
    const h = this.h - top;
    if (h < 70) return;

    const cy = top + h * 0.48;
    const r = Math.min(h * 0.3, this.w * 0.11);
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    // Left: floating d-pad affordance.
    const lx = this.w * 0.24;
    c.strokeStyle = 'rgba(255,246,255,0.16)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(lx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(255,246,255,0.3)';
    const a = r * 0.42;
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      c.beginPath();
      c.moveTo(lx + dx * a, cy + dy * a);
      c.lineTo(lx + dx * a * 0.45 - dy * a * 0.3, cy + dy * a * 0.45 + dx * a * 0.3);
      c.lineTo(lx + dx * a * 0.45 + dy * a * 0.3, cy + dy * a * 0.45 - dx * a * 0.3);
      c.closePath();
      c.fill();
    }

    // Right: the one button.
    const rx = this.w * 0.76;
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 3);
    c.strokeStyle = `rgba(255,176,32,${0.25 + pulse * 0.2})`;
    c.lineWidth = 2.5;
    c.beginPath();
    c.arc(rx, cy, r, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = 'rgba(255,176,32,0.08)';
    c.fill();
    c.fillStyle = 'rgba(255,176,32,0.75)';
    c.font = `${Math.round(r * 0.5)}px ${DISPLAY}`;
    c.fillText('ACTION', rx, cy);

    c.fillStyle = 'rgba(255,246,255,0.28)';
    c.font = `600 10px ${UI}`;
    c.fillText('DRAG ANYWHERE LEFT', lx, cy + r + 14);
    c.fillText('TAP ANYWHERE RIGHT', rx, cy + r + 14);
    c.restore();
  }

  private drawHudBar(c: CanvasRenderingContext2D, game: Game): void {
    const L = this.layout;
    const x = L.hudX;
    const y = L.hudY;
    const w = L.hudW;

    c.textAlign = 'left';
    c.fillStyle = PAL.ink;
    c.font = `${Math.round(Math.min(28, w * 0.07))}px ${DISPLAY}`;
    c.fillText('BOM', x, y);
    c.fillStyle = PAL.magenta;
    c.fillText('BAZ', x + c.measureText('BOM').width, y);

    c.font = `600 10px ${UI}`;
    c.fillStyle = 'rgba(255,246,255,0.45)';
    c.fillText(`SECTOR ${String(game.chapter + 1).padStart(2, '0')}`, x, y + 30);

    c.textAlign = 'right';
    c.fillStyle = PAL.ink;
    c.font = `${Math.round(Math.min(30, w * 0.075))}px ${DISPLAY}`;
    c.fillText(Math.floor(this.shownScore).toLocaleString(), x + w, y);
    c.fillStyle = PAL.cyan;
    c.font = `600 10px ${UI}`;
    c.fillText(`${Math.max(0, Math.floor(game.bestDepth))} m  ·  ${game.linesCleared} LINES`, x + w, y + 30);

    c.textAlign = 'left';
    const barY = y + 48;
    const h = 8;
    c.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(c, x, barY, w, h, h / 2);
    c.fill();
    const grad = c.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, PAL.violet);
    grad.addColorStop(1, PAL.magenta);
    c.fillStyle = grad;
    roundRect(c, x, barY, Math.max(h, w * game.danger), h, h / 2);
    c.fill();
    c.font = `700 9px ${UI}`;
    game.players.forEach((p, index) => {
      const tools = [p.lift ? 'LIFT' : p.slide ? 'SLIDE' : p.kick ? 'KICK' : '', p.magnet ? 'MAGNET' : '', p.pierce ? 'PIERCE' : '', p.shield ? `SHIELD ${p.shield}` : ''].filter(Boolean);
      c.fillStyle = PLAYER_COLORS[index];
      c.fillText(`P${index + 1}  BOMBS ${p.bombs}  BLAST ${p.power}  ${tools.join(' / ')}`, x, barY + 14 + index * 13, w);
    });
  }
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
