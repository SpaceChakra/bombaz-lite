import type { PadState } from '../input/input.js';
import type { ModeId } from '../game/constants.js';
import { RULES_VERSION } from './challenge.js';

export const MAX_REPLAY_TICKS = 120 * 60 * 30;
export const MAX_REPLAY_SEGMENTS = 50_000;
export type ReplaySegment = [ticks: number, p1: number, p2: number];
export interface RunReplay {
  version: number;
  seed: number;
  mode: ModeId;
  chassis: string;
  date: string;
  segments: ReplaySegment[];
}

export function encodePad(pad: PadState): number {
  const direction = pad.dx > 0 ? 1 : pad.dx < 0 ? 2 : pad.dy > 0 ? 3 : pad.dy < 0 ? 4 : 0;
  return direction | (pad.action ? 8 : 0);
}

export function decodePad(mask: number): PadState {
  const direction = mask & 7;
  return { dx: direction === 1 ? 1 : direction === 2 ? -1 : 0,
    dy: direction === 3 ? 1 : direction === 4 ? -1 : 0,
    action: !!(mask & 8), actionHeld: false, pause: false, device: 'none' };
}

export class RunRecorder {
  private ticks = 0;
  private overflow = false;
  private readonly segments: ReplaySegment[] = [];

  append(p1: number, p2: number): void {
    if (this.overflow) return;
    if (++this.ticks > MAX_REPLAY_TICKS) { this.overflow = true; return; }
    const last = this.segments.at(-1);
    if (last && last[1] === p1 && last[2] === p2) last[0]++;
    else if (this.segments.length >= MAX_REPLAY_SEGMENTS) this.overflow = true;
    else this.segments.push([1, p1, p2]);
  }

  finish(config: Omit<RunReplay, 'segments' | 'version'>): RunReplay | null {
    return this.overflow ? null : { ...config, version: RULES_VERSION, segments: this.segments };
  }
}
