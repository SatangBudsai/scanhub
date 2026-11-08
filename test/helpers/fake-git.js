// A tiny in-memory GitHub + GitLab API that records every call. GitHub lives under /gh, GitLab under /gl/api/v4.
import http from 'node:http';
import nacl from 'tweetnacl';

export async function startFakeGit() {
  const keys = nacl.box.keyPair();
  const state = {
    calls: [],
    keys: { publicKey: Buffer.from(keys.publicKey).toString('base64'), secretKey: Buffer.from(keys.secretKey).toString('base64') },
    gh: { secrets: {}, variables: {}, branches: new Set(['main']), files: {}, pulls: [] },
    gl: { variables: {}, branches: new Set(['main']), files: { main: { '.gitlab-ci.yml': 'stages:\n  - build\n  - test\n\nbuild:\n  stage: build\n  script:\n    - make\n' } }, mrs: [], commits: [] },
    ghScopes: 'repo, workflow',
  };
  const fileOf = (store, branch) => (store[branch] ||= {});

  const routes = [
    // ---------- GitHub ----------
    ['GET', /^\/gh\/user$/, (m, q, b, res) => { res.setHeader('x-oauth-scopes', state.ghScopes); return [200, { login: 'octo' }]; }],
    ['GET', /^\/gh\/user\/repos$/, () => [200, [
      { full_name: 'acme/payment-api', default_branch: 'main', clone_url: 'https://github.test/acme/payment-api.git', html_url: 'https://github.test/acme/payment-api', private: true },
      { full_name: 'acme/website', default_branch: 'master', clone_url: 'https://github.test/acme/website.git', html_url: 'https://github.test/acme/website', private: false },
    ]]],
    ['GET', /^\/gh\/repos\/acme\/payment-api$/, () => [200, { default_branch: 'main', clone_url: 'https://github.test/acme/payment-api.git', html_url: 'https://github.test/acme/payment-api' }]],
    ['GET', /^\/gh\/repos\/acme\/payment-api\/actions\/secrets\/public-key$/, () => [200, { key_id: 'kid-1', key: state.keys.publicKey }]],
    ['PUT', /^\/gh\/repos\/acme\/payment-api\/actions\/secrets\/(\w+)$/, (m, q, b) => { state.gh.secrets[m[1]] = b; return [201, {}]; }],
    ['POST', /^\/gh\/repos\/acme\/payment-api\/actions\/variables$/, (m, q, b) => {
      if (state.gh.variables[b.name]) return [409, { message: 'Already exists' }];
      state.gh.variables[b.name] = b.value;
      return [201, {}];
    }],
    ['PATCH', /^\/gh\/repos\/acme\/payment-api\/actions\/variables\/(\w+)$/, (m, q, b) => { state.gh.variables[m[1]] = b.value; return [204, null]; }],
    ['GET', /^\/gh\/repos\/acme\/payment-api\/git\/ref\/heads\/(.+)$/, () => [200, { object: { sha: 'base-sha-1' } }]],
    ['POST', /^\/gh\/repos\/acme\/payment-api\/git\/refs$/, (m, q, b) => {
      const name = b.ref.replace('refs/heads/', '');
      if (state.gh.branches.has(name)) return [422, { message: 'Reference already exists' }];
      state.gh.branches.add(name);
      return [201, {}];
    }],
    ['PATCH', /^\/gh\/repos\/acme\/payment-api\/git\/refs\/heads\/(.+)$/, () => [200, {}]],
    ['GET', /^\/gh\/repos\/acme\/payment-api\/contents\/(.+)$/, (m, q) => {
      const f = fileOf(state.gh.files, q.get('ref'))[decodeURIComponent(m[1])];
      return f ? [200, { sha: f.sha }] : [404, { message: 'Not Found' }];
    }],
    ['PUT', /^\/gh\/repos\/acme\/payment-api\/contents\/(.+)$/, (m, q, b) => {
      const path = decodeURIComponent(m[1]);
      const files = fileOf(state.gh.files, b.branch);
      if (files[path] && b.sha !== files[path].sha) return [409, { message: 'sha mismatch' }];
      files[path] = { content: Buffer.from(b.content, 'base64').toString('utf8'), sha: `sha-${state.calls.length}` };
      return [files[path] ? 200 : 201, { commit: { html_url: `https://github.test/acme/payment-api/commit/${state.calls.length}` } }];
    }],
    ['GET', /^\/gh\/repos\/acme\/payment-api\/pulls$/, (m, q) => [200, state.gh.pulls.filter((p) => `acme:${p.head}` === q.get('head'))]],
    ['POST', /^\/gh\/repos\/acme\/payment-api\/pulls$/, (m, q, b) => {
      const pr = { number: 7, html_url: 'https://github.test/acme/payment-api/pull/7', ...b };
      state.gh.pulls.push(pr);
      return [201, pr];
    }],

    // ---------- GitLab ----------
    ['GET', /^\/gl\/api\/v4\/user$/, () => [200, { username: 'gl-user' }]],
    ['GET', /^\/gl\/api\/v4\/personal_access_tokens\/self$/, () => [200, { scopes: ['api'] }]],
    ['GET', /^\/gl\/api\/v4\/projects$/, () => [200, [
      { path_with_namespace: 'grp/app', default_branch: 'main', http_url_to_repo: 'https://gitlab.test/grp/app.git', web_url: 'https://gitlab.test/grp/app', visibility: 'private' },
    ]]],
    ['GET', /^\/gl\/api\/v4\/projects\/grp%2Fapp$/, () => [200, { default_branch: 'main', http_url_to_repo: 'https://gitlab.test/grp/app.git', web_url: 'https://gitlab.test/grp/app' }]],
    ['POST', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/variables$/, (m, q, b) => {
      if (state.gl.variables[b.key]) return [400, { message: { key: ['(SCANHUB_TOKEN) has already been taken'] } }];
      state.gl.variables[b.key] = b;
      return [201, b];
    }],
    ['PUT', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/variables\/(\w+)$/, (m, q, b) => { state.gl.variables[m[1]] = b; return [200, b]; }],
    ['POST', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/repository\/branches$/, (m, q) => {
      const name = q.get('branch');
      if (state.gl.branches.has(name)) return [400, { message: 'Branch already exists' }];
      state.gl.branches.add(name);
      state.gl.files[name] = { ...fileOf(state.gl.files, q.get('ref')) };
      return [201, {}];
    }],
    ['GET', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/repository\/files\/(.+)\/raw$/, (m, q) => {
      const f = fileOf(state.gl.files, q.get('ref'))[decodeURIComponent(m[1])];
      return f !== undefined ? [200, f, 'text'] : [404, { message: '404 File Not Found' }];
    }],
    ['POST', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/repository\/commits$/, (m, q, b) => {
      const files = fileOf(state.gl.files, b.branch);
      for (const a of b.actions) {
        if (a.action === 'create' && files[a.file_path] !== undefined) return [400, { message: 'A file with this name already exists' }];
        if (a.action === 'update' && files[a.file_path] === undefined) return [400, { message: 'A file with this name doesn\'t exist' }];
        files[a.file_path] = a.content;
      }
      state.gl.commits.push(b);
      return [201, { web_url: `https://gitlab.test/grp/app/-/commit/${state.gl.commits.length}` }];
    }],
    ['GET', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/merge_requests$/, (m, q) => [200, state.gl.mrs.filter((x) => x.source_branch === q.get('source_branch'))]],
    ['POST', /^\/gl\/api\/v4\/projects\/grp%2Fapp\/merge_requests$/, (m, q, b) => {
      const mr = { iid: 3, web_url: 'https://gitlab.test/grp/app/-/merge_requests/3', ...b };
      state.gl.mrs.push(mr);
      return [201, mr];
    }],
  ];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      state.calls.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization || req.headers['private-token'] });
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (method === req.method && m) {
          const [status, data, kind] = fn(m, url.searchParams, body, res);
          res.statusCode = status;
          if (data === null) return res.end();
          if (kind === 'text') { res.setHeader('Content-Type', 'text/plain'); return res.end(data); }
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(data));
        }
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: `fake: no route ${req.method} ${url.pathname}` }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    github: `${base}/gh`,
    gitlab: `${base}/gl`,
    close: () => new Promise((r) => server.close(r)),
    callsMatching: (method, re) => state.calls.filter((c) => c.method === method && re.test(c.path)),
  };
}
