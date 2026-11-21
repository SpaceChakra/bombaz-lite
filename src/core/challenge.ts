export const RULES_VERSION = 8;

export function dailyKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dailySeed(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export function scoreBucket(mode: string, date: string): string {
  return `${mode}:v${RULES_VERSION}${mode === 'daily' ? `:${date}` : ''}`;
}
