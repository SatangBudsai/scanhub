// Gives each test run its own empty database.
// Uses TEST_DATABASE_URL when set, otherwise starts a throwaway postgres:16-alpine container.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import pg from 'pg';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (e) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) throw new Error(`postgres not ready: ${e.message}`);
      await sleep(1000);
    }
  }
}

export async function testDatabase() {
  let adminUrl = process.env.TEST_DATABASE_URL;
  let container = null;
  if (!adminUrl) {
    container = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=test', 'postgres:16-alpine'], { encoding: 'utf8' }).trim();
    // the mapped port can take a moment to show up
    let port = null;
    for (let i = 0; i < 30 && !port; i++) {
      try {
        const out = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
        port = /:(\d+)\s*$/m.exec(out)?.[1] || null;
      } catch { /* not ready */ }
      if (!port) await sleep(500);
    }
    if (!port) throw new Error('could not read the postgres container port');
    adminUrl = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  }
  const name = `scanhub_test_${crypto.randomBytes(4).toString('hex')}`;
  try {
    await waitFor(adminUrl);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
  } catch (e) {
    // do not leave the container running when setup fails
    if (container) { try { execFileSync('docker', ['stop', container], { stdio: 'ignore' }); } catch { /* gone */ } }
    throw e;
  }
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();

  return {
    url,
    async query(sql, params) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
    },
    async cleanup() {
      if (container) {
        try { execFileSync('docker', ['stop', container], { stdio: 'ignore' }); } catch { /* already gone */ }
        return;
      }
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await c.end();
    },
  };
}
