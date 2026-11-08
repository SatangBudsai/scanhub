import { config } from './config.js';

export const DEFAULT_SCHEDULE = { enabled: true, time: '03:00', updateDb: true };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getServerUrl(db) {
  return String((await db.getSetting('serverUrl', null)) || config.serverUrl).replace(/\/+$/, '');
}

/** SonarQube server in use: env wins when both SONAR_URL and SONAR_TOKEN are set */
export async function effectiveSonar(db) {
  if (config.sonarFromEnv) return { url: config.sonarUrl, token: config.sonarToken, fromEnv: true };
  const url = String((await db.getSetting('sonarUrl', '')) || '').replace(/\/+$/, '');
  const token = (await db.getSetting('sonarToken', '')) || '';
  return { url, token, fromEnv: false };
}

export async function effectiveNvdKey(db) {
  if (config.nvdFromEnv) return config.nvdApiKey;
  return (await db.getSetting('nvdApiKey', '')) || '';
}

export async function readSettings(db) {
  const rows = Object.fromEntries((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
  const get = (k, d) => (rows[k] === undefined || rows[k] === null ? d : rows[k]);
  const sonar = config.sonarFromEnv
    ? { url: config.sonarUrl, tokenSet: true, fromEnv: true }
    : { url: get('sonarUrl', '') || '', tokenSet: !!get('sonarToken', ''), fromEnv: false };
  return {
    serverUrl: String(get('serverUrl', '') || config.serverUrl).replace(/\/+$/, ''),
    retentionDays: get('retentionDays', 90),
    schedule: { ...DEFAULT_SCHEDULE, ...get('schedule', {}) },
    scanTime: get('scanTime', '02:00'),
    sonar,
    nvdKeySet: config.nvdFromEnv || !!get('nvdApiKey', ''),
    nvdFromEnv: config.nvdFromEnv,
    lastUpdateRun: get('lastUpdateRun', null),
    timezone: config.tz,
  };
}

export function validSchedule(s, current = DEFAULT_SCHEDULE) {
  if (s == null || typeof s !== 'object') throw new Error('schedule ไม่ถูกต้อง');
  const out = { ...current };
  if (s.enabled !== undefined) out.enabled = !!s.enabled;
  if (s.updateDb !== undefined) out.updateDb = !!s.updateDb;
  if (s.time !== undefined) {
    if (!TIME_RE.test(String(s.time))) throw new Error('เวลาต้องอยู่ในรูปแบบ HH:MM');
    out.time = String(s.time);
  }
  return out;
}

export const isTime = (t) => TIME_RE.test(String(t));
