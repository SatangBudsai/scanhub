// Runs the fake GitHub / GitLab API from the backend tests on 0.0.0.0 so the container can reach it
// through host.docker.internal. Adds /__state (recorded calls + stored secrets/files) and /__reset.
import http from 'node:http';
import { startFakeGit } from '../../test/helpers/fake-git.js';

export async function startFakeGitServer(port) {
  let fake = await startFakeGit();
  const inner = () => new URL(fake.github).origin;

  const snapshot = () => {
    const s = fake.state;
    return {
      calls: s.calls,
      keys: s.keys,
      gh: { secrets: s.gh.secrets, variables: s.gh.variables, branches: [...s.gh.branches], files: s.gh.files, pulls: s.gh.pulls },
      gl: { variables: s.gl.variables, branches: [...s.gl.branches], files: s.gl.files, mrs: s.gl.mrs, commits: s.gl.commits },
    };
  };

  const server = http.createServer(async (req, res) => {
    if (req.url === '/__state') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(snapshot()));
    }
    if (req.url === '/__reset' && req.method === 'POST') {
      await fake.close();
      fake = await startFakeGit();
      return res.end('ok');
    }
    const target = new URL(req.url, inner());
    const up = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { res.statusCode = 502; res.end(String(e.message)); });
    req.pipe(up);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  return {
    port,
    close: async () => { await new Promise((r) => server.close(r)); await fake.close(); },
  };
}
