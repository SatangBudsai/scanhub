// About / licenses: ScanHub version and license, bundled scanners and runtime components
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { requireRole } from '../auth.js';
import { CATALOG, spdxUrl } from '../tools/catalog.js';
import { ah, notFound } from '../util.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
export const NOTICES_FILE = path.join(root, 'THIRD_PARTY_NOTICES.md');
export const TRADEMARK = 'Product names and logos belong to their owners; ScanHub is not affiliated with or endorsed by them.';

const repoUrl = (pkg) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (pkg.homepage) return pkg.homepage;
  return r ? r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://') : `https://www.npmjs.com/package/${pkg.name}`;
};

/** Everything the About page shows; npm licenses are read from node_modules, not hard-coded */
export function aboutInfo() {
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const npm = Object.keys(pkg.dependencies || {}).sort().map((name) => {
    const dep = readJson(path.join(root, 'node_modules', name, 'package.json'));
    const lic = dep ? (typeof dep.license === 'string' ? dep.license : dep.license?.type) || null : null;
    return { name, version: dep?.version || null, license: lic, url: dep ? repoUrl(dep) : `https://www.npmjs.com/package/${name}`, licenseUrl: lic ? spdxUrl(lic) : null };
  });
  return {
    name: 'ScanHub',
    version: pkg.version || null,
    license: pkg.license || null,
    scanners: CATALOG.map((t) => ({ id: t.id, name: t.name, desc: t.desc, ...t.license })),
    runtime: [
      { name: 'PostgreSQL', version: '16', license: 'PostgreSQL', url: 'https://www.postgresql.org', licenseUrl: spdxUrl('PostgreSQL') },
      { name: 'Node.js', version: process.versions.node, license: 'MIT', url: 'https://nodejs.org', licenseUrl: spdxUrl('MIT') },
      ...npm,
    ],
    notices: '/api/about/notices',
    trademark: TRADEMARK,
  };
}

export function aboutRoutes() {
  const r = express.Router();
  // Same audience as settings
  r.get('/', requireRole('ADMIN', 'MAINTAINER'), ah(async (req, res) => res.json(aboutInfo())));
  r.get('/notices', requireRole('ADMIN', 'MAINTAINER'), ah(async (req, res) => {
    if (!fs.existsSync(NOTICES_FILE)) throw notFound('THIRD_PARTY_NOTICES.md not found');
    res.type('text/plain; charset=utf-8').send(fs.readFileSync(NOTICES_FILE, 'utf8'));
  }));
  return r;
}
