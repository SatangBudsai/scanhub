import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, dirs, VERSION } from './config.js';
import { openDb } from './db.js';
import { requireAuth, upsertEnvAdmin } from './auth.js';
import { ensureDir, HttpError } from './util.js';
import { createToolLock } from './tools/lock.js';
import { createToolManager } from './tools/manager.js';
import { cleanWorkDirs, createRunner } from './scan/runner.js';
import { createQueue } from './scan/queue.js';
import { startScheduler } from './scheduler.js';
import { runSonarAutoSetup } from './sonar-auto.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { settingsRoutes, setupRoutes, toolRoutes } from './routes/admin.js';
import { aboutRoutes } from './routes/about.js';
import { projectRoutes } from './routes/projects.js';
import { publicShareRoutes, reportRoutes } from './routes/reports.js';
import { ciRoutes } from './routes/ci.js';
import { groupRoutes } from './routes/groups.js';
import { integrationRoutes, syncEnvIntegrations } from './routes/integrations.js';

function fatal(msg) {
  console.error(msg);
  process.exit(1);
}

if (config.adminPassword.length < 8) fatal('SCANHUB_ADMIN_PASSWORD is required and must be at least 8 characters. Set it in docker-compose.yml and start again.');
if (config.adminPassword === 'change-me-please') {
  fatal('SCANHUB_ADMIN_PASSWORD is still the example value. Change it in docker-compose.yml, then run docker compose up -d again.');
}
if (!/^[a-z0-9._-]{2,40}$/.test(config.adminUser)) fatal('SCANHUB_ADMIN_USER may only contain a-z 0-9 . _ - (2-40 characters).');

async function main() {
  Object.values(dirs).forEach(ensureDir);
  ensureDir(path.join(config.dataDir, 'home'));
  const db = await openDb(config.databaseUrl);
  await upsertEnvAdmin(db, config.adminUser, config.adminPassword);
  await syncEnvIntegrations(db);

  // Scans and jobs do not survive a restart
  await db.run(`UPDATE scans SET status = 'failed', error = 'Server restarted during the scan', finished_at = COALESCE(finished_at, now()) WHERE status IN ('queued', 'running')`);
  await db.run('DELETE FROM sessions WHERE expires_at < now()');
  cleanWorkDirs();

  const lock = createToolLock();
  const tools = await createToolManager(db, lock);
  const runner = createRunner(db, tools, lock);
  const queue = createQueue(db, runner, config.concurrency);
  const ctx = { db, tools, runner, queue };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.get('/api/health', (req, res) => res.json({ ok: true, version: VERSION }));
  app.use('/api/v1', ciRoutes(ctx));

  app.use('/api', express.json({ limit: '2mb' }));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/share', publicShareRoutes(ctx));
  const authed = requireAuth(db);
  app.use('/api/users', authed, userRoutes(ctx));
  app.use('/api/setup', authed, setupRoutes(ctx));
  app.use('/api/tools', authed, toolRoutes(ctx));
  app.use('/api/settings', authed, settingsRoutes(ctx));
  app.use('/api/about', authed, aboutRoutes());
  app.use('/api', authed, groupRoutes(ctx));
  app.use('/api', authed, integrationRoutes(ctx));
  app.use('/api', authed, reportRoutes(ctx));
  app.use('/api', authed, projectRoutes(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API not found' }));

  // Share link viewer page, before the SPA fallback
  const reportFile = path.join(config.publicDir, 'report.html');
  app.get('/s/:token', (req, res) => {
    if (!fs.existsSync(reportFile)) return res.status(404).type('text').send('public/report.html not found');
    res.sendFile(reportFile, { headers: { 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' } });
  });

  // Web app
  const indexFile = path.join(config.publicDir, 'index.html');
  app.use(express.static(config.publicDir, { index: false, maxAge: '5m' }));
  app.get('*', (req, res) => {
    if (fs.existsSync(indexFile)) return res.sendFile(indexFile, { headers: { 'Cache-Control': 'no-cache' } });
    res.status(404).type('text').send('public/index.html not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    console.log(`ScanHub ${VERSION} listening on port ${server.address().port} · data ${config.dataDir} · admin "${config.adminUser}" from env`);
  });
  server.requestTimeout = 0; // CI uploads and wait=1 can take long
  server.headersTimeout = 120000;

  await startScheduler({ ...ctx, tz: config.tz });
  // Register scanners already on disk (e.g. after a database reset), in the background
  tools.reconcile().catch((e) => console.error('[tools] reconcile failed:', e.message));
  // Bundled SonarQube (SONAR_URL without SONAR_TOKEN): connect in the background, scans skip Sonar until ready
  if (config.sonarAuto) runSonarAutoSetup({ db });

  const shutdown = () => {
    server.close();
    db.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => fatal(`ScanHub failed to start: ${e.message}`));
