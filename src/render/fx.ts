/**
 * The "printed comic that is being deleted" layer.
 *
 * Everything expressive lives here so the simulation stays pure: screen shake,
 * chromatic misregistration, halftone dots, kinetic onomatopoeia and the
 * particle confetti that sells a line clear.
 */

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  spin: number;
  rot: number;
}

export interface FloatText {
  x: number;
  y: number;
  text: string;
  life: number;
  max: number;
  color: string;
  /** 0 = small score pop, 1 = big comic-panel onomatopoeia. */
  weight: number;
  rot: number;
  vy: number;
}

export class FxBus {
  shake = 0;
  aberration = 0;
  flash = 0;
  hitStop = 0;
  particles: Particle[] = [];
  texts: FloatText[] = [];

  private readonly rand = () => Math.random();

  kick(shake: number, aberration = shake * 0.6, flash = 0): void {
    this.shake = Math.max(this.shake, shake);
    this.aberration = Math.max(this.aberration, aberration);
    this.flash = Math.max(this.flash, flash);
  }

  /** Freeze the sim for a beat. Sells impact far better than more shake. */
  freeze(seconds: number): void {
    this.hitStop = Math.max(this.hitStop, seconds);
  }

  burst(x: number, y: number, count: number, colors: string[], speed = 6): void {
    for (let i = 0; i < count; i++) {
      const a = this.rand() * Math.PI * 2;
      const s = speed * (0.35 + this.rand() * 0.9);
      const max = 0.35 + this.rand() * 0.5;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: max,
        max,
        size: 0.08 + this.rand() * 0.16,
        color: colors[(this.rand() * colors.length) | 0],
        spin: (this.rand() - 0.5) * 12,
        rot: this.rand() * Math.PI,
      });
    }
  }

  say(x: number, y: number, text: string, color: string, weight = 1): void {
    this.texts.push({
      x,
      y,
      text,
      life: weight ? 1.0 : 0.75,
      max: weight ? 1.0 : 0.75,
      color,
      weight,
      rot: (this.rand() - 0.5) * (weight ? 0.22 : 0.08),
      vy: weight ? 1.1 : 2.4,
    });
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 26);
    this.aberration = Math.max(0, this.aberration - dt * 18);
    this.flash = Math.max(0, this.flash - dt * 4.5);
    this.hitStop = Math.max(0, this.hitStop - dt);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 11 * dt; // world Y is up, so gravity pulls negative
      p.vx *= 1 - 2.2 * dt;
      p.rot += p.spin * dt;
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.texts.splice(i, 1);
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= 1 - 1.8 * dt;
    }
  }

  clear(): void {
    this.particles.length = 0;
    this.texts.length = 0;
    this.shake = 0;
    this.aberration = 0;
    this.flash = 0;
    this.hitStop = 0;
  }
}

/** Cached halftone dot tile — the single strongest "printed" cue we have. */
export function makeHalftone(size = 6, dot = 1.15, alpha = 0.16): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = `rgba(255,255,255,${alpha})`;
  g.beginPath();
  g.arc(size / 2, size / 2, dot, 0, Math.PI * 2);
  g.fill();
  const host = document.createElement('canvas').getContext('2d');
  return host ? host.createPattern(c, 'repeat') : null;
}

/** Deterministic 0..1 hash used for the Void's per-tile dissolve. */
export function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
