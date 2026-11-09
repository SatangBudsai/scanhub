import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// timestamptz -> ISO string, int8 (COUNT/MAX/bigserial) -> number
pg.types.setTypeParser(1184, (v) => (v == null ? null : new Date(v).toISOString()));
pg.types.setTypeParser(20, (v) => (v == null ? null : Number(v)));

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Queries are written with ? placeholders; pg wants $1, $2, ...
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function helpers(q) {
  const exec = (sql, params) => q.query(toPg(sql), params);
  return {
    get: async (sql, ...p) => (await exec(sql, p)).rows[0],
    all: async (sql, ...p) => (await exec(sql, p)).rows,
    // INSERTs that need the new id end with RETURNING id
    run: async (sql, ...p) => {
      const r = await exec(sql, p);
      return { changes: r.rowCount, id: r.rows?.[0]?.id };
    },
  };
}

export async function openDb(url, { retryMs = 60000, log = console.log } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));

  // The database container may still be starting
  const deadline = Date.now() + retryMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await pool.connect();
      c.release();
      break;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Cannot connect to PostgreSQL (${e.message}). Check DATABASE_URL`);
      if (attempt === 1 || attempt % 5 === 0) log(`waiting for database: ${e.message}`);
      await sleep(2000);
    }
  }

  const base = helpers(pool);
  const db = {
    pool,
    ...base,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn(helpers(client));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async getSetting(key, fallback = null) {
      const row = await base.get('SELECT value FROM settings WHERE key = ?', key);
      return row && row.value !== null && row.value !== undefined ? row.value : fallback;
    },
    async setSetting(key, value) {
      await base.run(
        'INSERT INTO settings (key, value) VALUES (?, ?::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        key, JSON.stringify(value === undefined ? null : value),
      );
    },
    close: () => pool.end(),
  };
  await migrate(db, log);
  return db;
}

/** Apply server/migrations/NNN_name.sql files in order, once each. */
async function migrate(db, log) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7262001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration applied: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7262001)').catch(() => {});
    client.release();
  }
}
