import path from 'node:path';

const env = process.env;

export const VERSION = '1.0.0';

export const config = {
  adminUser: (env.SCANHUB_ADMIN_USER || 'admin').trim().toLowerCase(),
  adminPassword: env.SCANHUB_ADMIN_PASSWORD || '',
  serverUrl: (env.SCANHUB_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  port: env.PORT === undefined ? 8080 : Number(env.PORT),
  databaseUrl: env.DATABASE_URL || 'postgres://scanhub:scanhub@postgres:5432/scanhub',
  // /data in the container, ./data for local dev on other systems
  dataDir: path.resolve(env.DATA_DIR || (process.platform === 'linux' ? '/data' : './data')),
  tz: env.TZ || 'Asia/Bangkok',
  concurrency: Math.max(1, Number(env.SCAN_CONCURRENCY || 1)),
  maxUploadMb: Math.max(1, Number(env.MAX_UPLOAD_MB || 500)),
  githubToken: env.GITHUB_TOKEN || '',
  nvdApiKey: env.NVD_API_KEY || '',
  sonarUrl: (env.SONAR_URL || '').replace(/\/+$/, ''),
  sonarToken: env.SONAR_TOKEN || '',
  publicDir: path.resolve(import.meta.dirname, '..', 'public'),
  // Scanners built into the image
  imageToolsDir: path.resolve(env.SCANHUB_IMAGE_TOOLS || '/opt/scanhub/tools'),
};

// Values given in env configure the tool and are read-only in the settings page
config.sonarFromEnv = !!(config.sonarUrl && config.sonarToken);
config.nvdFromEnv = !!config.nvdApiKey;

export const dirs = {
  tools: path.join(config.dataDir, 'tools'),
  cache: path.join(config.dataDir, 'cache'),
  work: path.join(config.dataDir, 'work'),
  uploads: path.join(config.dataDir, 'uploads'),
};
