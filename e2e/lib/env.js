// Shared constants for the E2E suite. Global setup fills the env vars; workers inherit them.
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const E2E_DIR = path.join(ROOT, 'e2e');
export const RESULTS = path.join(E2E_DIR, 'results');
export const GIF_DIR = path.join(RESULTS, 'gifs');
export const SAMPLE_APP = path.join(ROOT, 'test', 'sample-app');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');

export const PORT = Number(process.env.E2E_PORT || 18080);
export const FAKE_GIT_PORT = Number(process.env.FAKE_GIT_PORT || 18181);
export const COMPOSE_PROJECT = 'scanhub-e2e';
export const CONTAINER = `${COMPOSE_PROJECT}-scanhub-1`;

export const ADMIN = {
  username: process.env.E2E_ADMIN_USER || 'admin',
  password: process.env.E2E_ADMIN_PASSWORD || 'e2e-admin-pass-2026',
};

export const baseURL = () => (process.env.E2E_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// Where the fake GitHub / GitLab API is reachable from the test process and from the container
export const fakeGitHost = () => process.env.E2E_FAKE_GIT || `http://127.0.0.1:${FAKE_GIT_PORT}`;
export const fakeGitFromApp = () => process.env.E2E_FAKE_GIT_APP || `http://host.docker.internal:${FAKE_GIT_PORT}`;
// true when the suite started the container itself (so it may run SQL inside it)
export const ownsContainer = () => process.env.E2E_OWNS_CONTAINER === '1';

// How every recorded page looks: dark by default, 2x pixels so GIF text stays sharp after downscaling
export const LOOK = { colorScheme: process.env.E2E_THEME === 'light' ? 'light' : 'dark', deviceScaleFactor: 2 };
