import { standardWeightLossDayRules } from './standardWeightLossDay.js';
import { demoWeightLossDayAug29Rules } from './demoWeightLossDayAug29.js';

export function dailyRulesNamed(value) {
  const name = String(value ?? 'standard').trim().toLowerCase();
  switch (name) {
    case 'standard':
    case 'standard-weight-loss-day':
      return standardWeightLossDayRules();
    case 'demo-aug29':
    case 'demo-2026-08-29':
    case 'demo-weight-loss-day-2026-08-29':
      return demoWeightLossDayAug29Rules();
    default:
      throw new Error(`Unknown daily rules '${value}'. Use 'standard' or 'demo-aug29'.`);
  }
}

export function clockSeconds(value, timeZone = 'America/New_York') {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 0;
  if (text === 'now') {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const hour = Number(values.hour) % 24;
    return (hour * 3600) + (Number(values.minute) * 60) + Number(values.second);
  }
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`Invalid --current-time '${value}'. Use HH:MM, HH:MM:SS, or now.`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid --current-time '${value}'. Use HH:MM, HH:MM:SS, or now.`);
  }
  return (hour * 3600) + (minute * 60) + second;
}

export function alternativeCount(value, fallback = 3) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new Error('--alternatives must be an integer from 0 through 5.');
  }
  return parsed;
}
