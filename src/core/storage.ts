import { dailyKey, dailySeed, scoreBucket } from './challenge.js';

export interface LeaderboardEntry {
  runId?: string;
  name: string;
  score: number;
  sector: number;
  depth: number;
  lines: number;
  date: string;
  mode: string;
}

export interface UserSettings {
  masterVol: number;
  sfxVol: number;
  musicVol: number;
  screenShake: boolean;
  chromaticAberration: boolean;
}

export interface StorageData {
  highScores: Record<string, LeaderboardEntry[]>;
  chips: number;
  totalRuns: number;
  totalLines: number;
  totalAltitude: number;
  unlockedChassis: string[];
  selectedChassis: string;
  settings: UserSettings;
  dailyLastPlayed: string;
  dailyStreak: number;
  lastInitials: string;
}

const STORAGE_KEY = 'bombaz_lite_save_v1';

const DEFAULT_SETTINGS: UserSettings = {
  masterVol: 0.8,
  sfxVol: 0.85,
  musicVol: 0.7,
  screenShake: true,
  chromaticAberration: true,
};

const DEFAULT_DATA: StorageData = {
  highScores: {
    solo: [],
    coop: [],
    versus: [],
    daily: [],
  },
  chips: 50,
  totalRuns: 0,
  totalLines: 0,
  totalAltitude: 0,
  unlockedChassis: ['standard'],
  selectedChassis: 'standard',
  settings: DEFAULT_SETTINGS,
  dailyLastPlayed: '',
  dailyStreak: 0,
  lastInitials: 'AAA',
};

class StorageManager {
  private data: StorageData;

  constructor() {
    this.data = this.load();
  }

  private load(): StorageData {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return structuredClone(DEFAULT_DATA);
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_DATA);
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_DATA,
        ...parsed,
        highScores: { ...DEFAULT_DATA.highScores, ...(parsed.highScores || {}) },
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        unlockedChassis: parsed.unlockedChassis?.length ? parsed.unlockedChassis : ['standard'],
      };
    } catch {
      return structuredClone(DEFAULT_DATA);
    }
  }

  save(): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      }
    } catch {}
  }

  getScores(mode: string): LeaderboardEntry[] {
    return this.data.highScores[scoreBucket(mode, this.getTodayDailyKey())] || [];
  }

  getLastInitials(): string {
    return (this.data.lastInitials || 'AAA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA';
  }

  setLastInitials(name: string): void {
    this.data.lastInitials = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA';
    this.save();
  }

  addScore(entry: LeaderboardEntry): number {
    const bucket = scoreBucket(entry.mode, entry.date);
    const list = (this.data.highScores[bucket] || []).filter(e => !entry.runId || e.runId !== entry.runId);
    list.push(entry);
    list.sort((a, b) => b.score - a.score);
    this.data.highScores[bucket] = list.slice(0, 10);
    this.save();
    return this.data.highScores[bucket].findIndex((e) => e === entry) + 1;
  }

  getChips(): number {
    return this.data.chips;
  }

  addChips(n: number): number {
    this.data.chips = Math.max(0, this.data.chips + n);
    this.save();
    return this.data.chips;
  }

  spendChips(n: number): boolean {
    if (this.data.chips < n) return false;
    this.data.chips -= n;
    this.save();
    return true;
  }

  recordRunStats(lines: number, altitude: number): void {
    this.data.totalRuns++;
    this.data.totalLines += lines;
    this.data.totalAltitude = Math.max(this.data.totalAltitude, altitude);
    this.save();
  }

  getUnlockedChassis(): string[] {
    return this.data.unlockedChassis;
  }

  isChassisUnlocked(id: string): boolean {
    return this.data.unlockedChassis.includes(id);
  }

  unlockChassis(id: string): boolean {
    if (this.isChassisUnlocked(id)) return true;
    this.data.unlockedChassis.push(id);
    this.save();
    return true;
  }

  getSelectedChassis(): string {
    return this.data.selectedChassis || 'standard';
  }

  setSelectedChassis(id: string): void {
    this.data.selectedChassis = id;
    this.save();
  }

  getSettings(): UserSettings {
    return this.data.settings;
  }

  saveSettings(s: Partial<UserSettings>): void {
    this.data.settings = { ...this.data.settings, ...s };
    this.save();
  }

  getTodayDailyKey(): string {
    return dailyKey();
  }

  getDailySeed(): number {
    return dailySeed(this.getTodayDailyKey());
  }

  hasPlayedDaily(): boolean {
    return this.data.dailyLastPlayed === this.getTodayDailyKey();
  }

  recordDailyPlayed(): void {
    const today = this.getTodayDailyKey();
    if (this.data.dailyLastPlayed !== today) {
      this.data.dailyStreak = (this.data.dailyStreak || 0) + 1;
      this.data.dailyLastPlayed = today;
      this.save();
    }
  }

  getDailyStreak(): number {
    return this.data.dailyStreak || 0;
  }
}

export const storage = new StorageManager();
