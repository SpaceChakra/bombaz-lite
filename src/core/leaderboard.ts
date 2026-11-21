/**
 * LITE EDITION: scores stay on this device. The full game verifies every run
 * on a server (replays re-simulated with the game code) and keeps global and
 * daily boards. These two functions keep the same shape, so the UI is unchanged.
 */
import { storage, type LeaderboardEntry } from './storage';
import type { RunReplay } from './recording';

export class ScoreRejectedError extends Error {}

export async function fetchGlobalScores(mode: string): Promise<LeaderboardEntry[]> {
  return storage.getScores(mode);
}

export async function submitGlobalScore(entry: LeaderboardEntry, _replay: RunReplay): Promise<{ rank: number; entries: LeaderboardEntry[] }> {
  const entries = [...storage.getScores(entry.mode), entry].sort((a, b) => b.score - a.score);
  return { rank: entries.indexOf(entry) + 1, entries };
}
