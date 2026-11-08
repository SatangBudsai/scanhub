import express from 'express';
import { clearSession, createSession, hashPassword, publicUser, requireAuth, verifyPassword } from '../auth.js';
import { ah, bad, HttpError } from '../util.js';
import { getServerUrl } from '../settings.js';

export function authRoutes({ db }) {
  const r = express.Router();

  // Simple brute-force brake per username + ip
  const fails = new Map();
  const tooMany = (k) => {
    const f = fails.get(k);
    return f && f.n >= 10 && Date.now() - f.t < 5 * 60 * 1000;
  };

  r.post('/login', ah(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const k = `${username}|${req.ip}`;
    if (tooMany(k)) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป รอ 5 นาทีแล้วลองใหม่');
    const u = username ? await db.get('SELECT * FROM users WHERE username = ?', username) : null;
    if (!u || !(await verifyPassword(password, u.pass_hash))) {
      const f = fails.get(k) || { n: 0, t: Date.now() };
      fails.set(k, { n: f.n + 1, t: Date.now() });
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    if (!u.active) throw new HttpError(401, 'บัญชีนี้ถูกปิดใช้งาน ติดต่อ admin');
    fails.delete(k);
    await db.run('UPDATE users SET last_login_at = now() WHERE id = ?', u.id);
    await createSession(db, u.id, res, req.secure);
    res.json({ user: publicUser(u) });
  }));

  r.post('/logout', ah(async (req, res) => {
    await clearSession(db, req, res);
    res.json({ ok: true });
  }));

  r.get('/me', requireAuth(db, { allowMustChange: true }), ah(async (req, res) => {
    res.json({ user: publicUser(req.user), setupDone: !!(await db.getSetting('setupDone', false)), serverUrl: await getServerUrl(db) });
  }));

  // A wrong current password is a 400 (not 401) so the client does not treat it as a logged-out session
  r.post('/change-password', requireAuth(db, { allowMustChange: true }), ah(async (req, res) => {
    const u = req.user;
    if (u.from_env) throw bad('รหัสผ่าน admin ตั้งค่าจาก env (SCANHUB_ADMIN_PASSWORD) แก้จากหน้าเว็บไม่ได้');
    const { current, newPassword } = req.body || {};
    if (!(await verifyPassword(String(current || ''), u.pass_hash))) throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (String(newPassword || '').length < 8) throw bad('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    if (newPassword === current) throw bad('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
    await db.run('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?', await hashPassword(newPassword), u.id);
    res.json({ user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', u.id)) });
  }));

  return r;
}
