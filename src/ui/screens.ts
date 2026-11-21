import type { Input } from '../input/input';
import type { Game } from '../game/game';
import type { ModeId } from '../game/constants';
import { storage, type LeaderboardEntry } from '../core/storage';
import { CHASSIS_LIST, getChassis } from '../game/progression';
import { audio } from '../core/audio';
import { fetchGlobalScores, submitGlobalScore, ScoreRejectedError } from '../core/leaderboard';

/** Seconds a freshly opened panel ignores input. */
const LOCKOUT = 0.45;

interface MenuItem {
  label: string;
  sub?: string;
  onPick: () => void;
  /** Keep the current panel open after choosing this item. */
  dismiss?: boolean;
}

/**
 * Menus are DOM, not canvas: crisp type at any DPI, real focus semantics for
 * screen readers, and one navigation model shared by stick, keys and touch.
 */
export class Screens {
  private readonly root: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private index = 0;
  private navLatch = false;
  private confirmLatch = true;
  /** Optional native first control for panels that include text entry. */
  private initialInput: HTMLInputElement | null = null;
  /** Bumped on every leaderboards() call so a stale fetch can't clobber a newer tab switch. */
  private leaderboardRequestId = 0;
  /** Seconds of deliberate deafness after a panel appears. */
  private lock = 0;
  private onBack: (() => void) | undefined;
  open = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private render(inner: string, items: MenuItem[], onBack?: () => void): void {
    this.onBack = onBack ?? items.find(it => /^Back/.test(it.label))?.onPick;
    this.initialInput = null;
    this.root.innerHTML = `<div class="panel">${inner}<div class="menu"></div></div>`;
    const menu = this.root.querySelector('.menu') as HTMLElement;
    this.buttons = items.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${it.label}${it.sub ? `<span class="sub">${it.sub}</span>` : ''}`;
      b.addEventListener('click', () => {
        if (it.dismiss !== false) this.hide();
        it.onPick();
      });
      menu.appendChild(b);
      return b;
    });
    this.buttons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('button'));
    this.buttons.forEach((button, i) => {
      button.addEventListener('focus', () => {
        this.index = i;
        this.buttons.forEach((b, k) => b.setAttribute('data-focus', k === i ? '1' : '0'));
      });
      button.addEventListener('mouseenter', () => this.focus(i));
    });
    this.navLatch = false;
    this.index = 0;
    this.focus(0);
    this.open = true;
    this.confirmLatch = true;
    this.lock = LOCKOUT;
    this.root.style.pointerEvents = 'auto';
  }

  private focus(i: number): void {
    if (!this.buttons.length) return;
    const direction = i < this.index ? -1 : 1;
    let next = (i + this.buttons.length) % this.buttons.length;
    for (let n = 0; n < this.buttons.length && this.buttons[next].disabled; n++) {
      next = (next + direction + this.buttons.length) % this.buttons.length;
    }
    this.index = next;
    this.buttons.forEach((b, k) => b.setAttribute('data-focus', k === this.index ? '1' : '0'));
    this.buttons[this.index]?.focus({ preventScroll: true });
    this.buttons[this.index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Horizontal rows (leaderboard modes) move on left/right. Everything else stays vertical. */
  private moveFocus(dx: number, dy: number): void {
    const onTab = !!this.buttons[this.index]?.closest('.tab-bar');
    if (onTab && dx !== 0) {
      this.focusTab(Math.sign(dx));
      return;
    }
    if (dy === 0) return;
    if (onTab) {
      const menu = this.buttons.findIndex((b) => !b.closest('.tab-bar') && !b.disabled);
      if (menu >= 0) this.focus(menu);
      return;
    }
    if (dy < 0 && this.index === 0 && this.initialInput && !this.initialInput.disabled) {
      this.focusInitialInput();
      return;
    }
    const dest = (this.index + (dy > 0 ? 1 : -1) + this.buttons.length) % this.buttons.length;
    if (this.buttons[dest]?.closest('.tab-bar')) {
      const active = this.buttons.findIndex((b) => b.classList.contains('active') && !!b.closest('.tab-bar'));
      this.focus(active >= 0 ? active : dest);
      return;
    }
    this.focus(dest);
  }

  private focusTab(direction: number): void {
    const tabs = this.buttons
      .map((button, index) => ({ button, index }))
      .filter(({ button }) => button.closest('.tab-bar') && !button.disabled);
    if (!tabs.length) return;
    const pos = Math.max(0, tabs.findIndex(({ index }) => index === this.index));
    const next = tabs[(pos + direction + tabs.length) % tabs.length];
    this.focus(next.index);
  }

  private focusActiveTab(): void {
    const active = this.buttons.findIndex((b) => b.classList.contains('active') && !!b.closest('.tab-bar'));
    if (active >= 0) this.focus(active);
  }

  private focusInitialInput(): void {
    if (!this.initialInput || this.initialInput.disabled) return;
    this.initialInput.focus({ preventScroll: true });
    this.initialInput.select();
  }

  hide(): void {
    this.leaderboardRequestId++;
    this.root.innerHTML = '';
    this.buttons = [];
    this.initialInput = null;
    this.open = false;
    this.root.style.pointerEvents = 'none';
  }

  /** Call every frame while a screen is open. */
  update(input: Input, dt = 1 / 60): void {
    if (!this.open || !this.buttons.length) return;
    if (this.lock > 0) {
      this.lock -= dt;
      return;
    }
    const m = input.readMenu();
    if (m.back && this.onBack) {
      const back = this.onBack;
      this.hide();
      back();
      return;
    }

    if (m.dx === 0 && m.dy === 0) this.navLatch = false;
    else if (!this.navLatch) {
      this.navLatch = true;
      this.moveFocus(m.dx, m.dy);
    }

    if (!m.confirm) this.confirmLatch = false;
    else if (!this.confirmLatch) {
      this.confirmLatch = true;
      this.buttons[this.index]?.click();
    }
  }

  // ------------------------------------------------------------- screens

  title(
    onStart: (mode: ModeId) => void,
    onHelp: () => void,
    onChassis: () => void,
    onLeaderboards: () => void,
    onSettings: () => void,
  ): void {
    const dailyKey = storage.getTodayDailyKey();
    const streak = storage.getDailyStreak();
    const playedToday = storage.hasPlayedDaily();
    const selected = getChassis(storage.getSelectedChassis());

    this.render(
      `<h1 class="wordmark"><span class="w-lead">BOM</span><span class="w-tail">BAZ</span></h1>
       <div class="title-badges">
         <span class="badge badge-lime">CHASSIS: ${escapeHtml(selected.name)}</span>
         <span class="badge badge-amber">CHIPS: ${storage.getChips()}</span>
         <span class="badge">LITE EDITION</span>
       </div>
       <p class="tagline" style="margin-top:6px">Full game + source: <a href="https://patreon.com/spacechakra" target="_blank" rel="noopener" style="color:inherit">patreon.com/spacechakra</a></p>`,
      [
        { label: 'Solo Run', sub: 'One runner against the Void', onPick: () => onStart('solo') },
        {
          label: `Daily Seed Run ${streak > 0 ? `· ${streak} days played` : ''}`,
          sub: `${dailyKey} · Standard chassis${playedToday ? ' · Played today' : ''}`,
          onPick: () => onStart('daily'),
        },
        { label: 'Co-op · 2P', sub: 'Share the tower, share the blame', onPick: () => onStart('coop') },
        { label: 'Versus · 2P', sub: 'Friendly fire on. Last one compiled wins', onPick: () => onStart('versus') },
        { label: 'Practice', sub: 'Frozen Void · no chips or ranked scores', onPick: () => onStart('tutorial') },
        { label: 'Chassis Bay', sub: 'Unlock & configure runner specs', onPick: onChassis },
        { label: 'Leaderboards', sub: 'Your best runs on this device', onPick: onLeaderboards },
        { label: 'Settings', sub: 'Audio, visuals, and controls', onPick: onSettings },
        { label: 'How to Play', onPick: onHelp },
      ],
    );
    const copyright = document.createElement('div');
    copyright.className = 'menu-copyright';
    copyright.textContent = `© ${new Date().getFullYear()} SpaceChakra`;
    this.root.appendChild(copyright);
  }

  chassisBay(onBack: () => void): void {
    const chips = storage.getChips();
    const unlocked = storage.getUnlockedChassis();
    const active = storage.getSelectedChassis();

    let cardsHtml = '<div class="chassis-grid">';
    for (const c of CHASSIS_LIST) {
      const isUnlocked = unlocked.includes(c.id);
      const isActive = c.id === active;
      const canAfford = chips >= c.cost;

      cardsHtml += `
        <div class="chassis-card ${isActive ? 'active' : ''}">
          <div class="chassis-info">
            <b style="color:${c.color}">${escapeHtml(c.name)} ${isActive ? '<span class="badge badge-lime">ACTIVE</span>' : ''}</b>
            <span style="color:var(--ink)">${escapeHtml(c.sub)}</span>
            <span>${escapeHtml(c.description)}</span>
          </div>
          <div>
            ${
              isActive
                ? '<button type="button" class="tab-btn" disabled style="opacity:.6">EQUIPPED</button>'
                : isUnlocked
                  ? `<button type="button" class="tab-btn" onclick="window.__equipChassis('${c.id}')">EQUIP</button>`
                  : `<button type="button" class="tab-btn" ${canAfford ? '' : 'disabled style="opacity:.4"'} onclick="window.__unlockChassis('${c.id}', ${c.cost})">${c.cost} CHIPS</button>`
            }
          </div>
        </div>
      `;
    }
    cardsHtml += '</div>';

    (window as any).__equipChassis = (id: string) => {
      storage.setSelectedChassis(id);
      this.chassisBay(onBack);
    };
    (window as any).__unlockChassis = (id: string, cost: number) => {
      if (storage.spendChips(cost)) {
        storage.unlockChassis(id);
        storage.setSelectedChassis(id);
        audio.playPowerup();
        this.chassisBay(onBack);
      }
    };

    this.render(
      `<h1 class="wordmark" style="font-size:clamp(28px,7vw,50px)">CHASSIS BAY</h1>
       <div style="margin:-10px auto 14px;font-size:12px;color:var(--amber)"><b>BYTE CHIPS: ${chips}</b></div>
       ${cardsHtml}`,
      [{ label: 'Back to Title', onPick: onBack }],
    );
  }

  leaderboards(onBack: () => void, mode = 'solo'): void {
    const modes = ['solo', 'daily', 'coop', 'versus'] as const;
    const requestToken = ++this.leaderboardRequestId;

    let tabsHtml = '<div class="tab-bar">';
    for (const m of modes) {
      tabsHtml += `<button type="button" class="tab-btn ${m === mode ? 'active' : ''}" onclick="window.__switchLeaderboardTab('${m}')">${m.toUpperCase()}</button>`;
    }
    tabsHtml += '</div>';

    (window as any).__switchLeaderboardTab = (m: string) => {
      this.leaderboards(onBack, m);
    };

    this.render(
      `<h1 class="wordmark" style="font-size:clamp(26px,6vw,46px)">LEADERBOARDS</h1>
       ${tabsHtml}
       <p style="text-align:center;padding:24px;opacity:.6">Loading scores…</p>`,
      [{ label: 'Back to Title', onPick: onBack }],
    );
    this.focusActiveTab();

    fetchGlobalScores(mode)
      .then((scores) => {
        if (requestToken !== this.leaderboardRequestId) return;
        this.renderLeaderboardTable(onBack, mode, tabsHtml, scores, null);
      })
      .catch(() => {
        if (requestToken !== this.leaderboardRequestId) return;
        this.renderLeaderboardTable(onBack, mode, tabsHtml, storage.getScores(mode), 'Couldn’t reach the global leaderboard — showing your locally saved scores.');
      });
  }

  private renderLeaderboardTable(
    onBack: () => void,
    mode: string,
    tabsHtml: string,
    scores: LeaderboardEntry[],
    notice: string | null,
  ): void {
    let tableHtml = `
      <table class="score-table">
        <thead>
          <tr>
            <th>#</th>
            <th>RUNNER</th>
            <th>SCORE</th>
            <th>SEC</th>
            <th>ALT</th>
            <th>LINES</th>
            <th>DATE</th>
          </tr>
        </thead>
        <tbody>
    `;

    if (scores.length === 0) {
      tableHtml += `<tr><td colspan="7" style="text-align:center;padding:24px;opacity:.5">No runs logged yet for ${mode.toUpperCase()}</td></tr>`;
    } else {
      scores.forEach((s, idx) => {
        tableHtml += `
          <tr>
            <td style="color:${idx === 0 ? 'var(--amber)' : 'inherit'}">${idx + 1}</td>
            <td style="font-weight:700;color:${idx === 0 ? 'var(--amber)' : 'var(--cyan)'}">${escapeHtml(s.name || 'ANON')}</td>
            <td>${s.score.toLocaleString()}</td>
            <td>S${s.sector}</td>
            <td>${s.depth}m</td>
            <td>${s.lines}</td>
            <td style="opacity:.6">${escapeHtml(s.date || '')}</td>
          </tr>
        `;
      });
    }
    tableHtml += '</tbody></table>';

    const noticeHtml = notice
      ? `<p style="text-align:center;font-size:11px;color:var(--amber);opacity:.85;margin:-8px 0 12px">${escapeHtml(notice)}</p>`
      : '';

    this.render(
      `<h1 class="wordmark" style="font-size:clamp(26px,6vw,46px)">LEADERBOARDS</h1>
       ${tabsHtml}
       <p class="hint" style="margin:0 0 12px">${mode === 'daily' ? `DAILY · ${storage.getTodayDailyKey()} · STANDARD CHASSIS` : 'VERIFIED RUNS'}</p>
       ${noticeHtml}
       ${tableHtml}`,
      [{ label: 'Back to Title', onPick: onBack }],
    );
    this.focusActiveTab();
  }

  settings(onBack: () => void): void {
    const s = storage.getSettings();

    const cycleVol = (curr: number) => {
      if (curr >= 0.99) return 0.75;
      if (curr >= 0.74) return 0.5;
      if (curr >= 0.49) return 0.25;
      if (curr >= 0.24) return 0.0;
      return 1.0;
    };

    const items: MenuItem[] = [
      {
        label: `Master Volume: ${Math.round(s.masterVol * 100)}%`,
        onPick: () => {
          const nv = cycleVol(s.masterVol);
          storage.saveSettings({ masterVol: nv });
          audio.updateVolumes();
          this.settings(onBack);
        },
      },
      {
        label: `SFX Volume: ${Math.round(s.sfxVol * 100)}%`,
        onPick: () => {
          const nv = cycleVol(s.sfxVol);
          storage.saveSettings({ sfxVol: nv });
          audio.updateVolumes();
          audio.playPowerup();
          this.settings(onBack);
        },
      },
      {
        label: `Music Volume: ${Math.round(s.musicVol * 100)}%`,
        onPick: () => {
          const nv = cycleVol(s.musicVol);
          storage.saveSettings({ musicVol: nv });
          audio.updateVolumes();
          this.settings(onBack);
        },
      },
      {
        label: `Screen Shake: ${s.screenShake ? 'ON' : 'OFF'}`,
        sub: 'Controls impact camera vibration',
        onPick: () => {
          storage.saveSettings({ screenShake: !s.screenShake });
          this.settings(onBack);
        },
      },
      {
        label: `Chromatic Glitch: ${s.chromaticAberration ? 'ON' : 'OFF'}`,
        sub: 'Controls panic misregistration effect',
        onPick: () => {
          storage.saveSettings({ chromaticAberration: !s.chromaticAberration });
          this.settings(onBack);
        },
      },
      { label: 'Back', onPick: onBack },
    ];

    this.render(
      `<h1 class="wordmark" style="font-size:clamp(28px,7vw,54px)">SETTINGS</h1>
       <p class="tagline" style="margin-bottom:18px">SYSTEM PREFERENCES</p>`,
      items,
    );
  }

  help(onBack: () => void): void {
    this.render(
      `<h1 class="wordmark" style="font-size:clamp(28px,7vw,54px)">HOW TO PLAY</h1>
       <div class="hint" style="text-align:left;opacity:.85;font-size:13px;line-height:1.9">
         <b style="color:#b4ff39">1 · CLIMB.</b> The Void eats the tower behind you. Up is the only direction that exists.<br>
         <b style="color:#ffb020">2 · BOMB.</b> One button. Blast bricks for power-ups, take out patrolling enemies. Exposed pickups burn in later blasts. Bomb capacity and blast reach grow without a cap.<br>
         <b style="color:#21e6ff">3 · CORES.</b> Every Gate wall has glowing reactor cores. Bomb each one; the wall holds until the last core goes down.<br>
         <b style="color:#ff2d95">4 · BREAK THROUGH.</b> The Void slows while you work a Gate. Clear it and the wall detonates and shoves the Void back down.<br>
         <p><b style="color:#ffb020">KICK &amp; SLIDE.</b> Collect Kick, then walk into a bomb to nudge it one tile. Collect Slide to send kicked bombs down the lane until something blocks them. Kick a bomb under a core you can't reach.</p>
         <p><b style="color:#b4ff39">LIFT.</b> Upgrade Kick to Slide, then Lift. Stop moving and tap Action while standing on a bomb or facing an adjacent bomb to carry it. Move to reposition, stop, then tap Action again to throw up to four tiles. The fuse pauses while held and resumes when thrown or dropped. Other blasts can still ignite it. Sealed gates block throws; no free landing means you keep holding the bomb.</p>
         <p><b style="color:#ffb020">PIERCE.</b> Available once blast power reaches 7. Blasts continue through bricks, but walls and gates still stop them.</p>
       </div>
       <p class="hint">
         <span class="kbd">WASD</span> / <span class="kbd">Arrows</span> / left stick — move &nbsp;·&nbsp;
         <span class="kbd">Space</span> / any face button — Action (bomb / tool)<br>
         P2 keyboard: <span class="kbd">IJKL</span> + <span class="kbd">R-Shift</span> &nbsp;·&nbsp;
         Touch: left half steers, right half uses Action
       </p>`,
      [{ label: 'Back', onPick: onBack }],
    );
  }

  paused(onResume: () => void, onSettings: () => void, onQuit: () => void): void {
    this.render(`<h1 class="wordmark" style="font-size:clamp(32px,8vw,64px)">PAUSED</h1>`, [
      { label: 'Resume', onPick: onResume },
      { label: 'Settings', onPick: onSettings },
      { label: 'Abandon Run', sub: 'Back to the title', onPick: onQuit },
    ], onResume);
  }

  /** Results land one stat at a time, each number rolling up to its value. */
  private tickStats(): void {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root.querySelectorAll<HTMLElement>('.stat-in').forEach((stat, i) => {
      const b = stat.querySelector<HTMLElement>('b[data-count]');
      if (!b) return;
      const target = Number(b.dataset.count) || 0;
      const fmt = (v: number) => `${b.dataset.prefix ?? ''}${v.toLocaleString()}${b.dataset.suffix ?? ''}`;
      if (reduce) return;
      const delay = 180 + i * 160;
      stat.style.animationDelay = `${delay}ms`;
      b.textContent = fmt(0);
      const start = performance.now() + delay;
      const run = (now: number) => {
        if (!b.isConnected) return;
        const k = Math.max(0, Math.min(1, (now - start) / 550));
        b.textContent = fmt(Math.round(target * (1 - (1 - k) ** 3)));
        if (k < 1) requestAnimationFrame(run);
      };
      requestAnimationFrame(run);
    });
  }

  gameOver(game: Game, onRetry: () => void, onMenu: () => void): void {
    const headline = game.mode === 'versus' && game.outcome.includes('WINS') ? game.outcome : 'RUN DELETED';
    const replay = game.replay;
    const canSubmit = game.score > 0 && game.mode !== 'tutorial' && replay !== null;
    game.saveLocalScore();

    let initialsHtml = '';
    if (canSubmit) {
      initialsHtml = `
        <div style="margin:10px 0 16px;padding:12px;background:rgba(33,230,255,0.08);border:1px solid var(--cyan);border-radius:10px">
          <span id="hs-status" style="font-size:12px;font-weight:700;color:var(--cyan);letter-spacing:0.1em">ENTER INITIALS TO SUBMIT YOUR RUN:</span>
          <div class="initials-row">
            <input type="text" id="hs-name" class="initials-input" maxlength="3" value="${escapeHtml(storage.getLastInitials())}" autofocus />
          </div>
        </div>
      `;
    }

    // The callback is installed after render, when the native input and its
    // matching menu button exist. Keeping the binding stable lets the button
    // work equally through click, keyboard, or gamepad confirmation.
    let submitScore = () => {};

    this.render(
      `<h1 class="wordmark" style="font-size:clamp(32px,8vw,68px)">${headline}</h1>
       <p class="tagline">${escapeHtml(game.outcome || 'the tower reclaimed you')}</p>
       ${game.mode === 'tutorial' ? '<p class="hint">PRACTICE · NO CHIPS OR RANKED SCORES</p>' : ''}
       <div class="stat-grid">
         <div class="stat stat-in"><b data-count="${game.score}">${game.score.toLocaleString()}</b><span>Score</span></div>
         <div class="stat stat-in"><b data-count="${Math.max(0, Math.floor(game.bestDepth))}" data-suffix="m">${Math.max(0, Math.floor(game.bestDepth))}m</b><span>Altitude</span></div>
         <div class="stat stat-in"><b data-count="${game.linesCleared}">${game.linesCleared}</b><span>Lines</span></div>
         <div class="stat stat-in"><b style="color:var(--amber)" data-count="${game.earnedChips}" data-prefix="+">+${game.earnedChips}</b><span>Chips</span></div>
       </div>
       ${initialsHtml}`,
      canSubmit
        ? [
            { label: 'Submit Score', onPick: () => submitScore(), dismiss: false },
            { label: 'Try Again', onPick: onRetry },
            { label: 'Main Menu', onPick: onMenu },
          ]
        : [
            { label: 'Try Again', onPick: onRetry },
            { label: 'Main Menu', onPick: onMenu },
          ],
    );

    this.tickStats();
    this.buttons.find((b) => b.textContent?.trim() === 'Try Again')?.classList.add('pulse');

    if (canSubmit) {
      const input = document.getElementById('hs-name') as HTMLInputElement;
      const status = document.getElementById('hs-status');
      const submitButton = this.buttons[0];
      let submitting = false;
      let saved = false;
      submitScore = () => {
        if (saved || submitting || !input || !submitButton) return;
        submitting = true;
        const name = (input.value || 'AAA').toUpperCase().slice(0, 3);
        const entry = { ...game.scoreEntry, name };
        storage.setLastInitials(name);
        storage.addScore(entry);
        submitButton.textContent = 'SUBMITTING…';
        submitButton.disabled = true;
        input.disabled = true;

        submitGlobalScore(entry, replay!)
          .then(({ rank }) => {
            saved = true;
            storage.addScore(entry);
            const savedLabel = rank <= 10 ? `SAVED! RANK #${rank}` : `SAVED! RANK #${rank}`;
            if (status) status.textContent = savedLabel;
            submitButton.textContent = savedLabel;
            submitButton.setAttribute('data-focus', '0');
            // Continue from a live control after saving; this also keeps a pad
            // from being left on the newly disabled Submit Score item.
            if (submitButton.isConnected) this.focus(1);
          })
          .catch((error) => {
            if (saved) return;
            if (error instanceof ScoreRejectedError) {
              if (status) status.textContent = 'RUN COULD NOT BE VERIFIED — YOUR LOCAL SCORE IS SAVED.';
              submitButton.textContent = 'SAVED LOCALLY';
              if (submitButton.isConnected) this.focus(1);
              return;
            }
            submitting = false;
            if (status) status.textContent = "COULDN'T REACH THE SERVER — TRY AGAIN:";
            submitButton.textContent = 'RETRY SUBMIT';
            submitButton.disabled = false;
            input.disabled = false;
          });
      };
      if (input) {
        this.initialInput = input;
        // Start where the player expects. This deliberately runs after the
        // menu has established its initial virtual selection.
        this.focusInitialInput();
        input.addEventListener('input', () => {
          input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
        });
        input.addEventListener('keydown', (event) => {
          if (event.code === 'Enter') {
            event.preventDefault();
            submitScore();
          } else if (event.code === 'ArrowDown') {
            event.preventDefault();
            this.focus(0);
          }
        });
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
