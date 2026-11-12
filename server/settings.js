import { config } from './config.js';
import { SONAR_STARTING_NOTE, sonarAutoStatus, sonarAutoToken } from './sonar-auto.js';

export const DEFAULT_SCHEDULE = { enabled: true, time: '03:00', updateDb: true };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function getServerUrl(db) {
  return String((await db.getSetting('serverUrl', null)) || config.serverUrl).replace(/\/+$/, '');
}

/** SonarQube server in use: env wins when both SONAR_URL and SONAR_TOKEN are set */
export async function effectiveSonar(db) {
  if (config.sonarFromEnv) return { url: config.sonarUrl, token: config.sonarToken, fromEnv: true };
  if (config.sonarAuto) {
    const token = await sonarAutoToken(db);
    const st = sonarAutoStatus();
    return { url: config.sonarUrl, token, fromEnv: true, auto: true, note: token ? null : st.state === 'error' ? st.message : SONAR_STARTING_NOTE };
  }
  const url = String((await db.getSetting('sonarUrl', '')) || '').replace(/\/+$/, '');
  const token = (await db.getSetting('sonarToken', '')) || '';
  return { url, token, fromEnv: false };
}

export async function effectiveNvdKey(db) {
  if (config.nvdFromEnv) return config.nvdApiKey;
  return (await db.getSetting('nvdApiKey', '')) || '';
}

/*
 * Semgrep rules source. Registry rules (p/default and other registry ids) are under the
 * Semgrep Rules License v1.0, so the person who runs ScanHub must accept it first.
 * Settings keys: semgrepRulesMode ('registry' | 'custom' | null), semgrepCustomRules, semgrepLicense {by, at}.
 */
export const SEMGREP_REGISTRY_RULES = 'p/default';
export const SEMGREP_LICENSE_URL = 'https://semgrep.dev/legal/rules-license';
export const SEMGREP_SKIP_NOTE = 'Semgrep skipped: choose a rules source in Settings';
export const isSemgrepRegistryId = (v) => {
  const t = String(v || '').trim();
  return /^(p|r)\//.test(t) || t === 'auto';
};

/** What the Semgrep scan uses: { rules: --config value | null, note when null, ... } */
export function semgrepFrom(rows) {
  if (config.semgrepFromEnv) {
    const registry = isSemgrepRegistryId(config.semgrepRules);
    const ok = !registry || config.semgrepLicenseAccepted;
    return {
      fromEnv: true, mode: registry ? 'registry' : 'custom', custom: registry ? '' : config.semgrepRules,
      envRules: config.semgrepRules, licenseAccepted: config.semgrepLicenseAccepted, acceptedBy: null, acceptedAt: null,
      rules: ok ? config.semgrepRules : null,
      note: ok ? null : 'Semgrep skipped: SEMGREP_RULES is a registry ruleset, set SEMGREP_RULES_LICENSE_ACCEPTED=true to accept the Semgrep Rules License',
    };
  }
  const mode = rows.semgrepRulesMode === 'registry' || rows.semgrepRulesMode === 'custom' ? rows.semgrepRulesMode : null;
  const custom = String(rows.semgrepCustomRules || '');
  const lic = rows.semgrepLicense && rows.semgrepLicense.at ? rows.semgrepLicense : null;
  let rules = null;
  if (mode === 'registry' && lic) rules = SEMGREP_REGISTRY_RULES;
  if (mode === 'custom' && custom.trim() && (!isSemgrepRegistryId(custom) || lic)) rules = custom.trim();
  return {
    fromEnv: false, mode, custom, envRules: null, licenseAccepted: !!lic,
    acceptedBy: lic ? lic.by || null : null, acceptedAt: lic ? lic.at : null,
    rules, note: rules ? null : SEMGREP_SKIP_NOTE,
  };
}

async function settingRows(db) {
  return Object.fromEntries((await db.all('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
}

export async function effectiveSemgrep(db) {
  return semgrepFrom(await settingRows(db));
}

/**
 * Validate a semgrep settings change ({mode, custom, acceptLicense}) against the current state.
 * Returns the setting writes as [key, value] pairs; throws Error with a user message.
 */
export function semgrepWrites(body, current, username) {
  if (body == null || typeof body !== 'object') throw new Error('Invalid Semgrep settings');
  const writes = [];
  let accepted = current.licenseAccepted;
  if (body.acceptLicense === true) {
    if (!current.licenseAccepted) writes.push(['semgrepLicense', { by: username || null, at: new Date().toISOString() }]);
    accepted = true;
  } else if (body.acceptLicense === false) {
    writes.push(['semgrepLicense', null]);
    accepted = false;
  }
  const mode = body.mode === undefined ? current.mode : body.mode;
  if (mode !== null && mode !== 'registry' && mode !== 'custom') throw new Error('Semgrep rules source must be registry or custom');
  if (body.mode !== undefined) writes.push(['semgrepRulesMode', mode]);
  if (mode === 'registry' && !accepted) throw new Error('Accept the Semgrep Rules License to use the Semgrep Registry rules');
  if (body.custom !== undefined) writes.push(['semgrepCustomRules', String(body.custom || '').trim()]);
  if (mode === 'custom') {
    const custom = String(body.custom === undefined ? current.custom : body.custom || '').trim();
    if (!custom) throw new Error('Enter the custom rules for Semgrep: a path, a URL or a ruleset id');
    if (custom.length > 2000) throw new Error('Custom rules are too long');
    if (isSemgrepRegistryId(custom) && !accepted) throw new Error('Rulesets from the Semgrep Registry need the Semgrep Rules License to be accepted');
  }
  return writes;
}

export async function readSettings(db) {
  const rows = await settingRows(db);
  const get = (k, d) => (rows[k] === undefined || rows[k] === null ? d : rows[k]);
  const sonar = config.sonarFromEnv
    ? { url: config.sonarUrl, tokenSet: true, fromEnv: true }
    : config.sonarAuto
    ? { url: config.sonarUrl, tokenSet: !!(rows.sonarAuto && rows.sonarAuto.token), fromEnv: true, auto: true, status: sonarAutoStatus() }
    : { url: get('sonarUrl', '') || '', tokenSet: !!get('sonarToken', ''), fromEnv: false };
  return {
    serverUrl: String(get('serverUrl', '') || config.serverUrl).replace(/\/+$/, ''),
    retentionDays: get('retentionDays', 90),
    schedule: { ...DEFAULT_SCHEDULE, ...get('schedule', {}) },
    scanTime: get('scanTime', '02:00'),
    sonar,
    nvdKeySet: config.nvdFromEnv || !!get('nvdApiKey', ''),
    nvdFromEnv: config.nvdFromEnv,
    semgrep: semgrepFrom(rows),
    lastUpdateRun: get('lastUpdateRun', null),
    timezone: config.tz,
  };
}

export function validSchedule(s, current = DEFAULT_SCHEDULE) {
  if (s == null || typeof s !== 'object') throw new Error('Invalid schedule');
  const out = { ...current };
  if (s.enabled !== undefined) out.enabled = !!s.enabled;
  if (s.updateDb !== undefined) out.updateDb = !!s.updateDb;
  if (s.time !== undefined) {
    if (!TIME_RE.test(String(s.time))) throw new Error('Time must be in HH:MM format');
    out.time = String(s.time);
  }
  return out;
}

export const isTime = (t) => TIME_RE.test(String(t));
