// GitHub and GitLab: test a token, list repos, and set up ScanHub CI in a repo (secret, file, PR/MR)
import { sealedBox } from './sealedbox.js';

export const SETUP_BRANCH = 'scanhub/setup';
export const PR_TITLE = 'Add ScanHub scan';
const PR_BODY = 'This PR adds a ScanHub scan step to CI: on every push the source is sent to ScanHub for scanning, and the combined results from all scanners are shown.\n\nCreated by ScanHub';
const COMMIT_MSG = 'ci: add ScanHub scan';
const GITLAB_FILE = '.gitlab/scanhub.yml';

export class GitApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function client(baseUrl, headers) {
  const root = String(baseUrl).replace(/\/+$/, '');
  return async function api(method, path, body, okStatuses = []) {
    const res = await fetch(root + path, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'scanhub', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = (data && (data.message || data.error || (Array.isArray(data.errors) && data.errors[0]?.message))) || res.statusText;
      throw new GitApiError(res.status, `${method} ${path.split('?')[0]} → ${res.status} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return { status: res.status, data, headers: res.headers };
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const enc = encodeURIComponent;
const encPath = (p) => p.split('/').map(enc).join('/');

/**
 * Scanners come from the repo settings in ScanHub, so changing them never needs a pipeline change.
 * A pipeline can still override them by setting SCANHUB_TOOLS (e.g. trivy,gitleaks); it is sent only when set.
 */
export const TOOLS_COMMENT = '# Scanners are chosen in ScanHub. To override here, set SCANHUB_TOOLS=trivy,gitleaks';
export const TOOLS_PARAM = '${SCANHUB_TOOLS:+&tools=$SCANHUB_TOOLS}';

/**
 * Shell lines run by every generated pipeline. `detect` sets KIND (branch | tag | pr), REF and BASE.
 * The job asks ScanHub first, so which branches and tags get scanned is set on the repo page, not in the pipeline.
 */
function scanScript(detect, commitVar) {
  return [
    'set +e',
    ...detect,
    '# ScanHub decides what to scan from the repo settings (branches, tags, pull requests)',
    'Q=$(printf \'kind=%s&branch=%s&base=%s\' "$KIND" "$REF" "$BASE" | sed \'s/+/%2B/g\')',
    'D=$(curl -sS -H "Authorization: Bearer $SCANHUB_TOKEN" -H "Accept: text/plain" "$SCANHUB_URL/api/v1/check?$Q" || echo scan)',
    'case "$D" in skip*) echo "$D"; exit 0;; esac',
    TOOLS_COMMENT,
    'tar --exclude=.git -czf - . | curl --fail-with-body -sS -X POST -T - -o scanhub-result.txt \\',
    '  -H "Authorization: Bearer $SCANHUB_TOKEN" -H "Content-Type: application/gzip" -H "Accept: text/plain" \\',
    `  "$SCANHUB_URL/api/v1/scan?$Q&commit=${commitVar}&wait=1${TOOLS_PARAM}"`,
    'rc=$?',
    'cat scanhub-result.txt 2>/dev/null; echo',
    'exit $rc',
  ];
}
const indent = (lines, pad) => lines.map((l) => pad + l).join('\n');

export function githubWorkflow(opts) {
  const detect = [
    'if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then KIND=pr; REF="$GITHUB_HEAD_REF"; BASE="$GITHUB_BASE_REF"',
    'else KIND="$GITHUB_REF_TYPE"; REF="$GITHUB_REF_NAME"; BASE=""; fi',
  ];
  return `# Added by ScanHub: sends the source to ScanHub, which runs every enabled scanner and keeps the results.
# SCANHUB_URL (variable) and SCANHUB_TOKEN (secret) are set in the repo's Actions settings.
# Runs on every branch, tag and pull request; the branches and tags that get scanned are set in ScanHub.
name: ScanHub

on:
  push:
    branches: ['**']
    tags: ['**']
  pull_request:
  workflow_dispatch:

jobs:
  scanhub:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Scan with ScanHub
        env:
          SCANHUB_URL: \${{ vars.SCANHUB_URL }}
          SCANHUB_TOKEN: \${{ secrets.SCANHUB_TOKEN }}
          SCANHUB_TOOLS: \${{ vars.SCANHUB_TOOLS }}  # optional override; scanners are chosen in ScanHub
        run: |
${indent(scanScript(detect, '$GITHUB_SHA'), '          ')}
`;
}

export function gitlabJob(opts) {
  const detect = [
    'if [ -n "$CI_MERGE_REQUEST_IID" ]; then KIND=pr; REF="$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME"; BASE="$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"',
    'elif [ -n "$CI_COMMIT_TAG" ]; then KIND=tag; REF="$CI_COMMIT_TAG"; BASE=""',
    'else KIND=branch; REF="$CI_COMMIT_REF_NAME"; BASE=""; fi',
  ];
  return `# Added by ScanHub: sends the source to ScanHub, which runs every enabled scanner and keeps the results.
# SCANHUB_URL and SCANHUB_TOKEN (masked) are set in Settings > CI/CD > Variables.
# Runs in every pipeline; the branches and tags that get scanned are set in ScanHub.
scanhub:
  stage: .pre  # exists in every GitLab pipeline and runs before other stages
  image: curlimages/curl:latest
  script:
    - |
${indent(scanScript(detect, '$CI_COMMIT_SHA'), '      ')}
`;
}

/**
 * Add `include: - local: .gitlab/scanhub.yml` to a .gitlab-ci.yml, keeping existing content.
 * Returns null when it is already included.
 */
export function mergeGitlabInclude(content) {
  const item = `local: ${GITLAB_FILE}`;
  const text = String(content || '');
  if (/local:\s*['"]?\/?\.gitlab\/scanhub\.yml['"]?/.test(text)) return null;
  if (!text.trim()) return `include:\n  - ${item}\n`;
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^include:/.test(l));
  if (idx < 0) return `include:\n  - ${item}\n\n${text}`;
  const inline = lines[idx].slice('include:'.length).trim();
  if (inline && !inline.startsWith('#')) {
    // include: 'a.yml'  or  include: [a.yml, b.yml]
    const existing = inline.startsWith('[')
      ? inline.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : [inline];
    lines.splice(idx, 1, 'include:', ...existing.map((e) => `  - ${e}`), `  - ${item}`);
    return lines.join('\n');
  }
  // block form: a list, or a single mapping that becomes the first list item
  let end = idx + 1;
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === '')) end++;
  while (end > idx + 1 && lines[end - 1].trim() === '') end--;
  const body = lines.slice(idx + 1, end);
  const first = body.find((l) => l.trim() && !l.trim().startsWith('#'));
  if (first && !first.trim().startsWith('-')) {
    let firstDone = false;
    for (let i = 0; i < body.length; i++) {
      if (!body[i].trim() || body[i].trim().startsWith('#')) continue;
      body[i] = firstDone ? `  ${body[i]}` : body[i].replace(/^(\s*)/, '$1- ');
      firstDone = true;
    }
  }
  const indent = (body.find((l) => l.trim().startsWith('-')) || '  -').match(/^\s*/)[0];
  return [...lines.slice(0, idx + 1), ...body, `${indent}- ${item}`, ...lines.slice(end)].join('\n');
}

/* ---------------- GitHub ---------------- */
function github(baseUrl, token) {
  const api = client(baseUrl || 'https://api.github.com', { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });

  async function test() {
    const { data, headers } = await api('GET', '/user');
    const scopes = headers.get('x-oauth-scopes');
    let missing = [];
    if (scopes !== null) {
      const have = scopes.split(',').map((s) => s.trim());
      missing = ['repo', 'workflow'].filter((s) => !have.includes(s));
    }
    // Fine-grained tokens do not list their permissions; they are checked when setup runs
    return { ok: true, account: data.login, scopesOk: missing.length === 0, missing };
  }

  async function repos(q) {
    const { data } = await api('GET', '/user/repos?sort=pushed&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member');
    const needle = String(q || '').toLowerCase();
    return (data || [])
      .filter((r) => !needle || r.full_name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, cloneUrl: r.clone_url, webUrl: r.html_url, private: !!r.private, language: r.language || '' }));
  }

  async function autoSetup(p, step) {
    const repo = `/repos/${encPath(p.fullName)}`;
    const info = (await api('GET', repo)).data;
    const def = p.branch || info.default_branch;
    const out = { prUrl: null, commitUrl: null, defaultBranch: info.default_branch, cloneUrl: info.clone_url, webUrl: info.html_url };

    await step('secret', async () => {
      const key = (await api('GET', `${repo}/actions/secrets/public-key`)).data;
      await api('PUT', `${repo}/actions/secrets/SCANHUB_TOKEN`, { encrypted_value: sealedBox(p.scanhubToken, key.key), key_id: key.key_id });
      const created = await api('POST', `${repo}/actions/variables`, { name: 'SCANHUB_URL', value: p.scanhubUrl }, [409, 422]);
      if (created.status === 409 || created.status === 422) await api('PATCH', `${repo}/actions/variables/SCANHUB_URL`, { name: 'SCANHUB_URL', value: p.scanhubUrl });
      return 'Set secret SCANHUB_TOKEN and variable SCANHUB_URL';
    });

    const target = p.mode === 'commit' ? def : SETUP_BRANCH;
    const path = '.github/workflows/scanhub.yml';
    await step('file', async () => {
      if (p.mode !== 'commit') {
        const base = (await api('GET', `${repo}/git/ref/heads/${encPath(def)}`)).data.object.sha;
        const made = await api('POST', `${repo}/git/refs`, { ref: `refs/heads/${SETUP_BRANCH}`, sha: base }, [422]);
        if (made.status === 422) await api('PATCH', `${repo}/git/refs/heads/${encPath(SETUP_BRANCH)}`, { sha: base, force: true });
      }
      const existing = await api('GET', `${repo}/contents/${encPath(path)}?ref=${enc(target)}`, undefined, [404]);
      const put = await api('PUT', `${repo}/contents/${encPath(path)}`, {
        message: COMMIT_MSG, content: b64(githubWorkflow({ ...p, defaultBranch: def })), branch: target,
        ...(existing.status === 200 && existing.data?.sha ? { sha: existing.data.sha } : {}),
      });
      out.commitUrl = put.data?.commit?.html_url || null;
      return `Added ${path} on branch ${target}`;
    });

    await step('pr', async () => {
      if (p.mode === 'commit') { return `Committed directly to ${def} (no PR)`; }
      const owner = p.fullName.split('/')[0];
      const open = (await api('GET', `${repo}/pulls?state=open&head=${enc(`${owner}:${SETUP_BRANCH}`)}`)).data || [];
      if (open.length) {
        out.prUrl = open[0].html_url;
        return `Updated existing PR #${open[0].number}`;
      }
      const pr = (await api('POST', `${repo}/pulls`, { title: PR_TITLE, head: SETUP_BRANCH, base: def, body: PR_BODY })).data;
      out.prUrl = pr.html_url;
      return `Opened PR #${pr.number}`;
    });
    return out;
  }

  return { test, repos, autoSetup };
}

/* ---------------- GitLab ---------------- */
function gitlab(baseUrl, token) {
  const api = client(`${String(baseUrl || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`, { 'PRIVATE-TOKEN': token });

  async function test() {
    const { data } = await api('GET', '/user');
    let missing = [];
    const self = await api('GET', '/personal_access_tokens/self', undefined, [401, 403, 404]);
    if (self.status === 200 && Array.isArray(self.data?.scopes) && !self.data.scopes.includes('api')) missing = ['api'];
    return { ok: true, account: data.username, scopesOk: missing.length === 0, missing };
  }

  async function repos(q) {
    const search = q ? `&search=${enc(q)}` : '';
    const { data } = await api('GET', `/projects?membership=true&simple=true&order_by=last_activity_at&sort=desc&per_page=50${search}`);
    return (data || []).slice(0, 50).map((r) => ({
      fullName: r.path_with_namespace, defaultBranch: r.default_branch, cloneUrl: r.http_url_to_repo, webUrl: r.web_url,
      private: r.visibility ? r.visibility !== 'public' : true, language: '',
    }));
  }

  async function setVariable(pid, key, value, masked) {
    const body = { key, value, masked, protected: false };
    const made = await api('POST', `/projects/${pid}/variables`, body, [400, 409]);
    if (made.status === 400 || made.status === 409) await api('PUT', `/projects/${pid}/variables/${enc(key)}`, body);
  }

  async function autoSetup(p, step) {
    const pid = enc(p.fullName);
    const info = (await api('GET', `/projects/${pid}`)).data;
    const def = p.branch || info.default_branch;
    const out = { prUrl: null, commitUrl: null, defaultBranch: info.default_branch, cloneUrl: info.http_url_to_repo, webUrl: info.web_url };

    await step('secret', async () => {
      await setVariable(pid, 'SCANHUB_TOKEN', p.scanhubToken, true);
      await setVariable(pid, 'SCANHUB_URL', p.scanhubUrl, false);
      return 'Set CI/CD variables SCANHUB_TOKEN (masked) and SCANHUB_URL';
    });

    const target = p.mode === 'commit' ? def : SETUP_BRANCH;
    await step('file', async () => {
      if (p.mode !== 'commit') await api('POST', `/projects/${pid}/repository/branches?branch=${enc(SETUP_BRANCH)}&ref=${enc(def)}`, undefined, [400, 409]);
      const file = async (path) => api('GET', `/projects/${pid}/repository/files/${enc(path)}/raw?ref=${enc(target)}`, undefined, [404]);
      const job = await file(GITLAB_FILE);
      const ci = await file('.gitlab-ci.yml');
      const actions = [{ action: job.status === 404 ? 'create' : 'update', file_path: GITLAB_FILE, content: gitlabJob(p) }];
      const merged = mergeGitlabInclude(ci.status === 404 ? '' : ci.data);
      if (merged !== null) actions.push({ action: ci.status === 404 ? 'create' : 'update', file_path: '.gitlab-ci.yml', content: merged });
      const commit = (await api('POST', `/projects/${pid}/repository/commits`, { branch: target, commit_message: COMMIT_MSG, actions })).data;
      out.commitUrl = commit?.web_url || null;
      return `Added ${GITLAB_FILE}${merged !== null ? ' and an include in .gitlab-ci.yml' : ''} on branch ${target}`;
    });

    await step('pr', async () => {
      if (p.mode === 'commit') return `Committed directly to ${def} (no MR)`;
      const open = (await api('GET', `/projects/${pid}/merge_requests?state=opened&source_branch=${enc(SETUP_BRANCH)}`)).data || [];
      if (open.length) {
        out.prUrl = open[0].web_url;
        return `Updated existing MR !${open[0].iid}`;
      }
      const mr = (await api('POST', `/projects/${pid}/merge_requests`, {
        source_branch: SETUP_BRANCH, target_branch: def, title: PR_TITLE, description: PR_BODY, remove_source_branch: true,
      })).data;
      out.prUrl = mr.web_url;
      return `Opened MR !${mr.iid}`;
    });
    return out;
  }

  return { test, repos, autoSetup };
}

export function provider(type, baseUrl, token) {
  if (type === 'github') return github(baseUrl, token);
  if (type === 'gitlab') return gitlab(baseUrl, token);
  throw new Error(`unknown provider ${type}`);
}

/** git clone auth header for a linked repo (keeps the token out of the URL and error messages) */
export function cloneAuthHeader(type, token) {
  const user = type === 'gitlab' ? 'oauth2' : 'x-access-token';
  return `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}
