// Server secret (generated once, stored in the db) and AES-256-GCM encryption for tokens at rest
import crypto from 'node:crypto';

let cached = null;

export async function serverSecret(db) {
  if (cached) return cached;
  let s = await db.getSetting('serverSecret', null);
  if (!s) {
    // First writer wins, so every instance uses the same secret
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO NOTHING', 'serverSecret', JSON.stringify(crypto.randomBytes(32).toString('hex')));
    s = await db.getSetting('serverSecret', null);
  }
  cached = s;
  return s;
}

const keyFrom = (secret) => crypto.createHash('sha256').update(`scanhub-token-encryption:${secret}`).digest();

export async function encrypt(db, plain) {
  const key = keyFrom(await serverSecret(db));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export async function decrypt(db, enc) {
  const raw = Buffer.from(String(enc).replace(/^v1:/, ''), 'base64');
  const key = keyFrom(await serverSecret(db));
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
