/**
 * One control verb. That is the whole design constraint: move + ACTION.
 *
 * ACTION is contextual, so a gamepad only ever needs the stick/d-pad and one
 * face button, a phone needs a thumb-zone and a tap, and a keyboard needs five
 * keys. Everything else in the game is expressed through movement.
 */
export interface PadState {
  /**
   * -1 | 0 | 1 for the current held direction (4-way, most-recent wins).
   *
   * These are **world axes, not screen axes**: +y is UP, matching the tower's
   * row numbering. Every device is normalised to that here so no consumer has
   * to remember which way round it is.
   */
  dx: number;
  dy: number;
  /** True on the frame ACTION went down. */
  action: boolean;
  /** True while ACTION is held (reserved for charged / remote detonation). */
  actionHeld: boolean;
  /** True on the frame PAUSE/BACK went down. */
  pause: boolean;
  /** Whichever device last moved this pad, for on-screen prompt swapping. */
  device: 'keyboard' | 'gamepad' | 'touch' | 'none';
}

interface Binds {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  action: string[];
  pause: string[];
}

const KEYBOARD_BINDS: Binds[] = [
  {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    action: ['Space', 'Enter', 'KeyJ'],
    pause: ['Escape', 'KeyP'],
  },
  {
    up: ['KeyI'],
    down: ['KeyK'],
    left: ['KeyJ'],
    right: ['KeyL'],
    action: ['ShiftRight', 'Slash', 'Period'],
    pause: ['Escape'],
  },
];

/** Player 2 on a shared keyboard steals IJKL, so P1 loses its KeyJ alias. */
function bindsFor(player: number, sharedKeyboard: boolean): Binds {
  if (player === 0 && sharedKeyboard) {
    return { ...KEYBOARD_BINDS[0], action: ['Space', 'Enter'] };
  }
  return KEYBOARD_BINDS[player] ?? KEYBOARD_BINDS[0];
}

const DEADZONE = 0.45;
/** Every face and shoulder button is ACTION. One verb, impossible to fumble. */
const ACTION_BUTTONS = [0, 1, 2, 3, 4, 5, 6, 7];

interface TouchZoneState {
  dx: number;
  dy: number;
  action: boolean;
  actionHeld: boolean;
}

export class Input {
  private readonly downKeys = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private readonly gpPrev = new Map<number, boolean[]>();
  private readonly gpPressed = new Map<number, Set<number>>();
  private touch: TouchZoneState = { dx: 0, dy: 0, action: false, actionHeld: false };
  private touchActive = false;
  private lastDevice: PadState['device'] = 'none';

  /** Player index -> gamepad index. Assigned first-come as pads wake up. */
  private readonly padMap = new Map<number, number>();

  sharedKeyboard = false;

  /** True once any touch happens, so the renderer can draw virtual controls. */
  get usingTouch(): boolean {
    return this.touchActive;
  }

  get device(): PadState['device'] {
    return this.lastDevice;
  }

  attach(target: HTMLElement): void {
    window.addEventListener('keydown', (e) => {
      // Native text fields own their editing keys.  Letting a name-entry
      // field leak WASD/arrows/Enter into the game UI can move selection or
      // activate a menu item while the player is still typing.
      if (isTextEditingTarget(e.target)) return;
      if (e.repeat) return;
      // Stop the page scrolling, and Space/Enter re-activating a focused
      // button natively — the menu loop already turns a confirm press into
      // exactly one `.click()` itself, so a native activation on top of that
      // double-fires: it can trigger a second menu item that a handler moved
      // focus onto (e.g. Save Score handing focus to Try Again once saved).
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Enter') e.preventDefault();
      this.downKeys.add(e.code);
      this.pressedKeys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.downKeys.delete(e.code));
    window.addEventListener('blur', () => {
      this.downKeys.clear();
      this.touch = { dx: 0, dy: 0, action: false, actionHeld: false };
    });
    window.addEventListener('gamepadconnected', () => {
      this.lastDevice = 'gamepad';
    });

    this.attachTouch(target);
  }

  private attachTouch(target: HTMLElement): void {
    // Left half of the screen is a floating d-pad anchored wherever the thumb
    // lands; right half is one big ACTION button. No fixed hitbox to miss.
    let originX = 0;
    let originY = 0;
    let stickId = -1;
    const actionIds = new Set<number>();

    const onStart = (e: TouchEvent) => {
      // Menus use real controls. Do not suppress their native touch behaviour
      // or a score field cannot receive focus / open the on-screen keyboard.
      if (isTextEditingTarget(e.target) || isInteractiveTarget(e.target)) return;
      this.touchActive = true;
      this.lastDevice = 'touch';
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth * 0.5) {
          stickId = t.identifier;
          originX = t.clientX;
          originY = t.clientY;
        } else {
          actionIds.add(t.identifier);
          this.touch.action = true;
          this.touch.actionHeld = true;
        }
      }
      e.preventDefault();
    };

    const onMove = (e: TouchEvent) => {
      if (isTextEditingTarget(e.target) || isInteractiveTarget(e.target)) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier !== stickId) continue;
        const vx = t.clientX - originX;
        const vy = t.clientY - originY;
        const dead = Math.min(window.innerWidth, window.innerHeight) * 0.035;
        if (Math.hypot(vx, vy) < dead) {
          this.touch.dx = 0;
          this.touch.dy = 0;
        } else if (Math.abs(vx) > Math.abs(vy)) {
          this.touch.dx = Math.sign(vx);
          this.touch.dy = 0;
        } else {
          this.touch.dx = 0;
          this.touch.dy = -Math.sign(vy);
        }
      }
      e.preventDefault();
    };

    const onEnd = (e: TouchEvent) => {
      if (isTextEditingTarget(e.target) || isInteractiveTarget(e.target)) return;
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === stickId) {
          stickId = -1;
          this.touch.dx = 0;
          this.touch.dy = 0;
        } else {
          actionIds.delete(t.identifier);
          this.touch.actionHeld = actionIds.size > 0;
        }
      }
      e.preventDefault();
    };

    target.addEventListener('touchstart', onStart, { passive: false });
    target.addEventListener('touchmove', onMove, { passive: false });
    target.addEventListener('touchend', onEnd, { passive: false });
    target.addEventListener('touchcancel', onEnd, { passive: false });
  }

  /** Call once per frame *before* reading pads. */
  poll(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const prev = this.gpPrev.get(gp.index) ?? [];
      const now = gp.buttons.map((b) => b.pressed);
      let fresh = this.gpPressed.get(gp.index);
      if (!fresh) {
        fresh = new Set();
        this.gpPressed.set(gp.index, fresh);
      }
      fresh.clear();
      for (let i = 0; i < now.length; i++) {
        if (now[i] && !prev[i]) {
          fresh.add(i);
          this.lastDevice = 'gamepad';
        }
      }
      this.gpPrev.set(gp.index, now);
    }
  }

  /** Call once per frame *after* every pad has been read. */
  endFrame(): void {
    this.pressedKeys.clear();
    this.touch.action = false;
    for (const s of this.gpPressed.values()) s.clear();
  }

  /** Clear all input states during screen/state transitions. */
  clear(): void {
    this.downKeys.clear();
    this.pressedKeys.clear();
    this.touch = { dx: 0, dy: 0, action: false, actionHeld: false };
    for (const s of this.gpPressed.values()) s.clear();
  }

  private gamepadFor(player: number): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    const assigned = this.padMap.get(player);
    if (assigned !== undefined && pads[assigned]) return pads[assigned];

    const taken = new Set(this.padMap.values());
    for (const gp of pads) {
      if (!gp || taken.has(gp.index)) continue;
      this.padMap.set(player, gp.index);
      return gp;
    }
    return null;
  }

  read(player: number): PadState {
    const b = bindsFor(player, this.sharedKeyboard);
    const held = (codes: string[]) => codes.some((c) => this.downKeys.has(c));
    const hit = (codes: string[]) => codes.some((c) => this.pressedKeys.has(c));
    // A direction counts as active if it is held OR went down this frame. A
    // tap that starts and ends between two frames is invisible to held-state
    // alone, which silently eats quick menu taps and quick single steps.
    const dir = (codes: string[]) => held(codes) || hit(codes);

    let dx = (dir(b.right) ? 1 : 0) - (dir(b.left) ? 1 : 0);
    let dy = (dir(b.up) ? 1 : 0) - (dir(b.down) ? 1 : 0);
    let action = hit(b.action);
    let actionHeld = held(b.action);
    let pause = hit(b.pause);
    let device: PadState['device'] = dx || dy || actionHeld ? 'keyboard' : 'none';

    const gp = this.gamepadFor(player);
    if (gp) {
      const fresh = this.gpPressed.get(gp.index) ?? new Set<number>();
      const ax = gp.axes[0] ?? 0;
      const ay = gp.axes[1] ?? 0;
      const pad = (i: number) => gp.buttons[i]?.pressed || fresh.has(i);
      const gdx =
        (pad(15) ? 1 : 0) - (pad(14) ? 1 : 0) ||
        (Math.abs(ax) > DEADZONE ? Math.sign(ax) : 0);
      const gdy =
        (pad(12) ? 1 : 0) - (pad(13) ? 1 : 0) ||
        (Math.abs(ay) > DEADZONE ? -Math.sign(ay) : 0);
      const gAction = ACTION_BUTTONS.some((i) => fresh.has(i));
      const gHeld = ACTION_BUTTONS.some((i) => gp.buttons[i]?.pressed);
      const gPause = fresh.has(9) || fresh.has(8) || fresh.has(16);

      if (gdx || gdy) {
        dx = gdx;
        dy = gdy;
        device = 'gamepad';
      }
      action = action || gAction;
      actionHeld = actionHeld || gHeld;
      pause = pause || gPause;
      if (gAction || gHeld) device = 'gamepad';
    }

    const t = this.touch;
    if (player === 0 && (t.dx || t.dy || t.actionHeld || t.action)) {
      dx = t.dx || dx;
      dy = t.dy || dy;
      action = action || t.action;
      actionHeld = actionHeld || t.actionHeld;
      device = 'touch';
    }

    // 4-way lock: a diagonal resolves to its horizontal, which keeps grid
    // stepping and Sokoban pushes unambiguous.
    if (dx && dy) dy = 0;

    return { dx, dy, action, actionHeld, pause, device };
  }

  /**
   * UI navigation, pooled across every connected device.
   *
   * Menus are laid out top-to-bottom on screen, so `dy` is flipped back to
   * screen space here: +1 moves to the next item down the list.
   */
  readMenu(): { dx: number; dy: number; confirm: boolean; back: boolean } {
    const p0 = this.read(0);
    const p1 = this.read(1);
    return {
      dx: p0.dx || p1.dx,
      dy: -(p0.dy || p1.dy),
      confirm: p0.action || p1.action,
      back: p0.pause || p1.pause,
    };
  }
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('button, a, select, [role="button"]');
}
