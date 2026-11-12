import fs from 'node:fs';
import path from 'node:path';
import { dirs } from '../config.js';
import { ensureDir, findFile, readJsonFile, runCmd, tail } from '../util.js';

const HOUR = 3600 * 1000;
const RUN_TIMEOUT = 30 * 60 * 1000;

export const spdxUrl = (id) => `https://spdx.org/licenses/${id}.html`;

export const linuxArch = () => (process.arch === 'arm64' ? 'arm64' : 'x64');

/*
 * Each catalog item:
 *   source: how to install ('github' release asset, 'pip' venv, 'sonar' zip)
 *   binName: executable to look for after install
 *   versionArgs: args printing the version
 *   run({ bin, src, out, ctx }): runs the scan, returns { data } or { skip: note }
 *   updateDb({ bin, ctx }): optional vulnerability DB update
 *   license: { component, spdx, url, licenseUrl, note?, noteUrl? } shown on the About page and in THIRD_PARTY_NOTICES.md
 */
export const CATALOG = [
  {
    id: 'sonarqube', name: 'SonarQube', needsConfig: true,
    license: { component: 'SonarQube Scanner CLI', spdx: 'LGPL-3.0', url: 'https://github.com/SonarSource/sonar-scanner-cli', licenseUrl: spdxUrl('LGPL-3.0'), note: 'The SonarQube server is your own and is not bundled' },
    desc: 'Code quality and SAST: bugs, code smells, security hotspots (uses your existing SonarQube server)',
    source: 'sonar', binName: 'sonar-scanner', versionArgs: ['--version'],
  },
  {
    id: 'trivy', name: 'Trivy',
    license: { component: 'Trivy', spdx: 'Apache-2.0', url: 'https://github.com/aquasecurity/trivy', licenseUrl: spdxUrl('Apache-2.0') },
    desc: 'Vulnerabilities in dependencies, secrets, and IaC/Dockerfile misconfigurations',
    source: 'github', repo: 'aquasecurity/trivy', binName: 'trivy', versionArgs: ['--version'],
    asset: (v) => `trivy_${v}_Linux-${linuxArch() === 'arm64' ? 'ARM64' : '64bit'}.tar.gz`,
    async run({ bin, src, out }) {
      const file = path.join(out, 'trivy.json');
      const r = await runCmd(bin, ['fs', '--scanners', 'vuln,secret,misconfig', '--format', 'json', '--output', file,
        '--cache-dir', path.join(dirs.cache, 'trivy'), '--quiet', src], { timeoutMs: RUN_TIMEOUT });
      return reportOrFail(r, file);
    },
    async updateDb({ bin }) {
      return runCmd(bin, ['image', '--download-db-only', '--cache-dir', path.join(dirs.cache, 'trivy'), '--quiet'], { timeoutMs: HOUR });
    },
  },
  {
    id: 'semgrep', name: 'Semgrep',
    license: { component: 'Semgrep (engine)', spdx: 'LGPL-2.1', url: 'https://github.com/semgrep/semgrep', licenseUrl: spdxUrl('LGPL-2.1'), note: 'Registry rules (p/default and other registry rulesets) are under the Semgrep Rules License v1.0 (internal use only)', noteUrl: 'https://semgrep.dev/legal/rules-license' },
    desc: 'SAST with customizable rules, 30+ languages',
    source: 'pip', pkg: 'semgrep', binName: 'semgrep', versionArgs: ['--version'],
    async run({ bin, src, out, ctx }) {
      const file = path.join(out, 'semgrep.json');
      if (!ctx?.semgrepRules) return { skip: 'Semgrep skipped: choose a rules source in Settings' };
      const r = await runCmd(bin, ['scan', '--config', ctx.semgrepRules, '--json', '--output', file, '--metrics', 'off', '--quiet', src],
        { timeoutMs: RUN_TIMEOUT, env: { SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0' } });
      return reportOrFail(r, file);
    },
  },
  {
    id: 'gitleaks', name: 'Gitleaks',
    license: { component: 'Gitleaks', spdx: 'MIT', url: 'https://github.com/gitleaks/gitleaks', licenseUrl: spdxUrl('MIT') },
    desc: 'Finds secrets and credentials leaked in code',
    source: 'github', repo: 'gitleaks/gitleaks', binName: 'gitleaks', versionArgs: ['version'],
    asset: (v) => `gitleaks_${v}_linux_${linuxArch()}.tar.gz`,
    async run({ bin, src, out }) {
      const file = path.join(out, 'gitleaks.json');
      const r = await runCmd(bin, ['dir', src, '--report-format', 'json', '--report-path', file, '--exit-code', '0', '--no-banner'],
        { timeoutMs: RUN_TIMEOUT });
      return reportOrFail(r, file);
    },
  },
  {
    id: 'dependency-check', name: 'OWASP Dependency-Check',
    license: { component: 'OWASP Dependency-Check', spdx: 'Apache-2.0', url: 'https://github.com/jeremylong/DependencyCheck', licenseUrl: spdxUrl('Apache-2.0') },
    desc: 'Matches dependencies against CVEs from NVD (the first run downloads the database; an NVD API key is recommended)',
    source: 'github', repo: 'jeremylong/DependencyCheck', binName: 'dependency-check.sh', versionArgs: ['--version'],
    asset: (v) => `dependency-check-${v}-release.zip`,
    async run({ bin, src, out, ctx }) {
      const data = path.join(dirs.cache, 'dependency-check');
      if (!fs.existsSync(data) || !fs.readdirSync(data).length) {
        return { skip: 'No NVD database yet. Click "Update all now" in Settings first' };
      }
      const args = ['--scan', src, '--format', 'JSON', '--out', out, '--data', data, '--noupdate', '--disableAssembly'];
      if (ctx.nvdApiKey) args.push('--nvdApiKey', ctx.nvdApiKey);
      const r = await runCmd(bin, args, { timeoutMs: RUN_TIMEOUT });
      return reportOrFail(r, path.join(out, 'dependency-check-report.json'));
    },
    async updateDb({ bin, ctx }) {
      const args = ['--updateonly', '--data', ensureDir(path.join(dirs.cache, 'dependency-check'))];
      if (ctx.nvdApiKey) args.push('--nvdApiKey', ctx.nvdApiKey);
      return runCmd(bin, args, { timeoutMs: 3 * HOUR });
    },
  },
  {
    id: 'checkov', name: 'Checkov',
    license: { component: 'Checkov', spdx: 'Apache-2.0', url: 'https://github.com/bridgecrewio/checkov', licenseUrl: spdxUrl('Apache-2.0') },
    desc: 'Misconfigurations in Terraform, Kubernetes, Dockerfile and CI config',
    source: 'pip', pkg: 'checkov', binName: 'checkov', versionArgs: ['--version'],
    async run({ bin, src, out }) {
      const r = await runCmd(bin, ['-d', src, '-o', 'json', '--output-file-path', out, '--quiet', '--compact', '--soft-fail', '--skip-download'],
        { timeoutMs: RUN_TIMEOUT });
      return reportOrFail(r, path.join(out, 'results_json.json'), () => ({ data: [] }));
    },
  },
  {
    id: 'grype', name: 'Grype',
    license: { component: 'Grype', spdx: 'Apache-2.0', url: 'https://github.com/anchore/grype', licenseUrl: spdxUrl('Apache-2.0') },
    desc: 'Vulnerabilities in dependencies and the filesystem, from the Anchore database',
    source: 'github', repo: 'anchore/grype', binName: 'grype', versionArgs: ['version'],
    asset: (v) => `grype_${v}_linux_${linuxArch() === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`,
    env: () => ({ GRYPE_DB_CACHE_DIR: path.join(dirs.cache, 'grype'), GRYPE_CHECK_FOR_APP_UPDATE: 'false' }),
    async run({ bin, src, out }) {
      const file = path.join(out, 'grype.json');
      const r = await runCmd(bin, [`dir:${src}`, '-o', 'json', '--file', file, '-q'], { timeoutMs: RUN_TIMEOUT, env: this.env() });
      return reportOrFail(r, file);
    },
    async updateDb({ bin }) {
      return runCmd(bin, ['db', 'update'], { timeoutMs: HOUR, env: this.env() });
    },
  },
];

export const TOOL_IDS = CATALOG.map((t) => t.id);
export const toolById = (id) => CATALOG.find((t) => t.id === id);

function reportOrFail(r, file, onMissing) {
  if (fs.existsSync(file)) {
    try {
      return { data: readJsonFile(file) };
    } catch (e) {
      return { error: `Could not read output: ${e.message}` };
    }
  }
  if (r.timedOut) return { error: 'Took longer than 30 minutes' };
  if (onMissing && r.code === 0) return onMissing();
  return { error: tail(r.stderr || r.stdout) || `exit code ${r.code}` };
}

export function versionFrom(text) {
  const m = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

export function toolBinIn(dir, item) {
  if (item.source === 'pip') {
    const p = path.join(dir, 'venv', 'bin', item.binName);
    return fs.existsSync(p) ? p : null;
  }
  if (item.source === 'sonar') return findFile(dir, (p, n) => n === 'sonar-scanner' && /[\\/]bin[\\/]/.test(p));
  return findFile(dir, (p, n) => n === item.binName);
}
