import { Loop } from './core/loop';
import { Input } from './input/input';
import { Game } from './game/game';
import type { ModeId } from './game/constants';
import { Renderer } from './render/renderer';
import { Screens } from './ui/screens';
import { audio } from './core/audio';

import { storage } from './core/storage';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLElement;

const input = new Input();
input.attach(document.getElementById('app') as HTMLElement);

const renderer = new Renderer(canvas);
const screens = new Screens(overlay);
const pauseButton = document.createElement('button');
pauseButton.id = 'pause-button';
pauseButton.type = 'button';
pauseButton.textContent = 'Pause';
pauseButton.hidden = true;
pauseButton.addEventListener('click', () => { if (game?.phase === 'playing' && !screens.open) showPaused(); });
document.getElementById('app')!.appendChild(pauseButton);

let game: Game | null = null;
let pauseLatch = false;
/** Guards the one-shot transition into the results panel. */
let resultsPending = false;

// Initialize / resume audio on first user interaction (browser autoplay compliance)
const initAudio = () => {
  audio.init();
  audio.resume();
  window.removeEventListener('click', initAudio);
  window.removeEventListener('keydown', initAudio);
  window.removeEventListener('touchstart', initAudio);
};
window.addEventListener('click', initAudio);
window.addEventListener('keydown', initAudio);
window.addEventListener('touchstart', initAudio);

function newRun(mode: ModeId): void {
  input.clear();
  input.sharedKeyboard = mode !== 'solo' && mode !== 'daily' && mode !== 'tutorial';
  const seed = mode === 'daily' ? storage.getDailySeed() : (Math.random() * 0xffffffff) >>> 0;
  const runId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  game = new Game({ mode, seed, chassisId: storage.getSelectedChassis(), runId, record: true });
  resultsPending = false;
  screens.hide();
  audio.init().then(() => {
    audio.updateVolumes();
    audio.startPlayBed();
  });
}

function toTitle(): void {
  game = null;
  screens.title(
    newRun,
    () => screens.help(toTitle),
    () => screens.chassisBay(toTitle),
    () => screens.leaderboards(toTitle),
    () => screens.settings(toTitle),
  );
  audio.stopPlayBed();
}

function showPaused(): void {
  if (!game) return;
  game.phase = 'paused';
  const g = game;
  audio.stopPlayBed();
  screens.paused(
    () => {
      input.clear();
      pauseLatch = false;
      g.phase = 'playing';
      audio.startPlayBed();
    },
    () => screens.settings(showPaused),
    toTitle,
  );
}

window.addEventListener('blur', () => {
  if (game?.phase === 'playing' && !screens.open) showPaused();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game?.phase === 'playing' && !screens.open) showPaused();
});

const loop = new Loop(
  (dt) => {
    input.poll();

    if (screens.open) {
      screens.update(input, dt);
      input.endFrame();
      return;
    }

    if (game) {
      const pad0 = input.read(0);
      const pad1 = game.players.length > 1 ? input.read(1) : null;
      const wantPause = pad0.pause || pad1?.pause;

      if (!wantPause) pauseLatch = false;
      else if (!pauseLatch && game.phase !== 'over') {
        pauseLatch = true;
        showPaused();
      }

      game.update(dt, input);

      if (game.phase === 'over' && !screens.open && !resultsPending) {
        resultsPending = true;
        const g = game;
        audio.stopPlayBed();
        // Let the death FX breathe before the results panel lands.
        window.setTimeout(() => {
          if (game !== g) return;
          resultsPending = false;
          screens.gameOver(g, () => newRun(g.mode), toTitle);
        }, 900);
      }
    }

    input.endFrame();
  },

  (alpha) => {
    pauseButton.hidden = !game || game.phase !== 'playing' || screens.open;
    if (game) renderer.draw(game, alpha);
    else renderer.drawIdle();
  },
);

// SpaceChakra splash: letters rise left-to-right, title row then PRESENTS.
// Clicking through is the user gesture that unlocks audio before the menu.
function runSplash(onDone: () => void): void {
  const splash = document.getElementById('splash');
  if (!splash) return onDone();
  const STEP = 0.05;
  let delay = 0;
  for (const line of splash.querySelectorAll<HTMLElement>('.splash-title, .splash-presents')) {
    const text = line.textContent ?? '';
    line.textContent = '';
    for (const c of text) {
      const span = document.createElement('span');
      span.className = 'ch';
      span.textContent = c;
      span.style.animationDelay = `${delay.toFixed(2)}s`;
      line.appendChild(span);
      delay += STEP;
    }
    delay += 0.15;
  }
  // Corner stamp identifies the running copy before anyone reaches the menu.
  const stamp = document.createElement('div');
  stamp.className = 'build-stamp';
  stamp.textContent = __BUILD_ID__;
  splash.appendChild(stamp);
  const prompt = splash.querySelector<HTMLElement>('.splash-prompt');
  if (prompt) {
    const t = delay + 0.2;
    prompt.style.animation = `splash-fade 0.8s linear ${t}s forwards, splash-breathe 4s ease-in-out ${t + 0.8}s infinite`;
  }

  let done = false;
  const finish = (e: Event) => {
    if (done) return;
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
    done = true;
    e.preventDefault();
    window.removeEventListener('keydown', finish);
    initAudio();
    input.clear();
    splash.classList.add('out');
    setTimeout(() => splash.remove(), 400);
    onDone();
  };
  splash.addEventListener('click', finish);
  splash.addEventListener('touchend', finish);
  window.addEventListener('keydown', finish);
}

runSplash(toTitle);
loop.start();

// Dev-only handle so the visual smoke test can drive real runs deterministically
// instead of pantomiming menu input.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__bombaz = {
    start: (mode: ModeId) => newRun(mode),
    menu: toTitle,
    get game() {
      return game;
    },
  };
}

// Keep the canvas honest across rotation and browser-chrome resizes.
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));
