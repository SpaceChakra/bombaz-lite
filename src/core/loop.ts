/**
 * Fixed-timestep loop. The simulation always advances in whole STEP chunks so
 * physics, puzzle pushes and the Void are frame-rate independent; rendering
 * gets the leftover alpha for interpolation.
 */
export const STEP = 1 / 120;

export class Loop {
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  constructor(
    private readonly update: (dt: number) => void,
    private readonly render: (alpha: number) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      // Clamp so an alt-tab does not fast-forward the player into the Void.
      const frame = Math.min((now - this.last) / 1000, 0.25);
      this.last = now;
      this.acc += frame;
      let guard = 0;
      while (this.acc >= STEP && guard++ < 60) {
        this.update(STEP);
        this.acc -= STEP;
      }
      this.render(this.acc / STEP);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
