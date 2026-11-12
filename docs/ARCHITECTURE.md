# ScanHub architecture

One place to scan repos with several security scanners and keep every result. Results of all tools are merged into one list per scan, and compared with the previous scan (new / existing / fixed).

## Layout

```
server/            Node.js 22 server (ESM, dependencies: express, pg)
  index.js         entry: config, db, admin-from-env, routes, scheduler, static
  config.js        env parsing
  db.js            PostgreSQL pool (pg), migrations on start, helpers
  auth.js          password hashing (crypto.scrypt), sessions, role guards
  routes/*.js      API routers
  tools/catalog.js scanner catalog: install, update, version, run command
  tools/manager.js install / update / remove, logs, db updates
  scan/queue.js    scan queue (concurrency from env)
  scan/runner.js   prepare source, run tools, collect reports
  scan/parsers/*.js one parser per report format -> normalized findings
  scan/merge.js    dedupe across tools, fingerprint, diff vs previous scan, snippets
  scheduler.js     daily tool update, daily repo scans, retention cleanup
public/index.html  the web app (design D wired to the API), single file
designs/           the UX prototypes (A-D) kept for reference
Dockerfile (single image: server + PostgreSQL + scanners), docker/entrypoint.sh, docker-compose.yml, .env.example
```

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `SCANHUB_ADMIN_USER` | `admin` | admin username. Re-applied on every start |
| `SCANHUB_ADMIN_PASSWORD` | (required) | admin password. Re-applied on every start (min 8 chars) |
| `SCANHUB_URL` | `http://localhost:8080` | public URL shown in CI snippets (can be overridden in settings) |
| `PORT` | `8080` | |
| `DATABASE_URL` | (empty) | external PostgreSQL. Empty = start the PostgreSQL bundled in the image |
| `DATA_DIR` | `/data` | tools, caches, work dirs (no database files) |
| `TZ` | `Asia/Bangkok` | schedule times use this zone |
| `SCAN_CONCURRENCY` | `1` | scans run at the same time |
| `MAX_UPLOAD_MB` | `500` | max source upload |
| `GITHUB_TOKEN` | | optional, avoids GitHub API rate limit when installing tools |
| `NVD_API_KEY` | | optional, makes OWASP Dependency-Check DB download usable |
| `SONAR_URL`, `SONAR_TOKEN` | | optional defaults for the existing SonarQube server (settings page can override) |
| `SEMGREP_RULES` | | optional Semgrep `--config` value (registry id, URL or path). Set = read-only in settings |
| `SEMGREP_RULES_LICENSE_ACCEPTED` | | `true` accepts the Semgrep Rules License; required when `SEMGREP_RULES` is a registry id (`p/…`, `r/…`, `auto`) |

On every start the server upserts the env admin: username from env, password hash from env, role `ADMIN`, active, `from_env=1`, `must_change=0`. If the env username changed, the previous env admin row gets `from_env=0` and is disabled. The env admin cannot be edited, disabled or have its password changed from the UI.

## Database

PostgreSQL 16, bundled inside the image and started automatically when `DATABASE_URL` is empty (see Single image), or any existing server via `DATABASE_URL`. Schema is created and migrated on start by numbered SQL migrations in `server/migrations/` tracked in a `schema_migrations` table; the server retries the connection for up to 60s at boot. Findings are stored in a `findings` table (one row per finding per scan, with `jsonb` for rules/tools/refs/snippet) indexed by `scan_id` and `(repo_id, fingerprint)`. Wrap scan result writes in one transaction.

## Project access

ADMIN sees everything. Every other user sees a project only if one of these is true:
- the user has `allProjects = true`
- the user has a direct grant to that project
- the user is a member of a group that has that project (or a group with `allProjects = true`)

The creator of a project gets a direct grant automatically. Repos, scans, findings, reports and internal share links follow their project. A project the user cannot see returns 404 everywhere (lists simply omit it). Role permissions still apply on top: access decides *which* projects, role decides *what* the user can do there. New users default to `allProjects = false` with no grants.

- `GET /api/groups` (ADMIN) -> `[{id, name, allProjects, memberIds:[userId], projectIds:[projectId], createdAt}]`
- `POST /api/groups` `{name, allProjects?, memberIds?, projectIds?}`; `PATCH /api/groups/:id` (same fields, arrays replace); `DELETE /api/groups/:id`
- `GET /api/users` items also include `{allProjects, projectIds, groupIds}`
- `PATCH /api/users/:id` also accepts `{allProjects, projectIds, groupIds}` (arrays replace). Not for the env admin (always everything).
- `GET /api/projects/:id/access` (ADMIN) -> `{users:[{id, username, via:["direct"|"all"|"group:<name>"]}], groups:[{id, name}]}` — who can see a project, for the project menu.
- `GET /api/share/:token` internal mode: the logged-in user must also have access to the project, else 403 `{code:"NO_ACCESS"}`.

## Roles

| Permission | ADMIN | MAINTAINER | ANALYST | VIEWER |
| --- | --- | --- | --- | --- |
| View projects, repos, scans | yes | yes | yes | yes |
| Trigger a scan | yes | yes | yes | no |
| Create / edit / delete projects and repos, regenerate tokens | yes | yes | no | no |
| View settings and scanners | yes | yes | no | no |
| Change settings, install / update / remove scanners, setup | yes | no | no | no |
| Manage users | yes | no | no | no |

## API

All JSON. Errors: `{ "error": "message" }` with 4xx/5xx. Session cookie `sh_session` (httpOnly, SameSite=Lax, 7 days). Times are ISO strings. Severity order everywhere: `critical, high, medium, low, info`; `counts` is always an array of 5 numbers in that order.

### Auth
- `POST /api/auth/login` `{username, password}` -> `{user}`; 401 on bad creds or disabled user
- `POST /api/auth/logout` -> `{ok:true}`
- `GET /api/auth/me` -> `{user, setupDone, serverUrl}`; 401 when not logged in
- `POST /api/auth/change-password` `{current, newPassword}` -> `{user}`. Clears `mustChange`. 400 for the env admin.

`user` = `{id, username, role, mustChange, fromEnv}`. While `mustChange` is true every other API returns 403 `{error, code:"MUST_CHANGE_PASSWORD"}`.

### Users (ADMIN)
- `GET /api/users` -> `[{id, username, role, active, mustChange, fromEnv, lastLoginAt, createdAt}]`
- `POST /api/users` `{username, password, role}` -> user. username `^[a-z0-9._-]{2,40}$`, password >= 8. New users have `mustChange=true`.
- `PATCH /api/users/:id` `{role?, active?}` -> user. 400 for env admin. Disabling deletes that user's sessions.
- `POST /api/users/:id/reset-password` `{password}` -> user (`mustChange=true`, sessions removed)

### Setup
- `GET /api/setup` -> `{done, catalog: [catalogItem]}`
- `POST /api/setup` (ADMIN) `{tools:[id], schedule:{enabled, time:"03:00", updateDb}}` -> `{ok:true}`. Saves schedule, marks setup done, queues install of each tool (progress via `GET /api/tools`).

`catalogItem` = `{id, name, desc, needsConfig}`. Tool ids: `sonarqube, trivy, semgrep, gitleaks, dependency-check, checkov, grype`.

### Scanners (GET: ADMIN+SA, writes: ADMIN)
- `GET /api/tools` -> `[{id, name, desc, installed, version, updatedAt, status, error, needsConfig, configured}]`. `status`: `idle | installing | updating | removing | error`. `configured` is false for sonarqube until URL+token are set.
- `POST /api/tools/:id/install`, `POST /api/tools/:id/update`, `DELETE /api/tools/:id` -> `{ok:true}` (async; poll the list)
- `POST /api/tools/update-all` -> `{ok:true}` (same job the schedule runs: update installed tools + vulnerability DBs)
- `GET /api/tools/log` -> `[{at, tool, action, ok, message}]` newest first, max 100

### Settings (GET: ADMIN+SA, PUT: ADMIN)
- `GET /api/settings` -> `{serverUrl, retentionDays, schedule:{enabled, time, updateDb}, scanTime, sonar:{url, tokenSet}, nvdKeySet, semgrep, lastUpdateRun:{at, ok, summary} | null, timezone}`
- `PUT /api/settings` partial of `{serverUrl, retentionDays, schedule, scanTime, sonar:{url, token}, nvdApiKey, semgrep:{mode, custom, acceptLicense}}` -> same shape as GET. Empty string token keeps the old one; `null` clears it.
- `semgrep` = `{mode: "registry"|"custom"|null, custom, rules: <--config value> | null, note, licenseAccepted, acceptedBy, acceptedAt, fromEnv, envRules}`. Registry mode (`p/default`) needs the Semgrep Rules License accepted (`acceptLicense: true` stores who and when in the `semgrepLicense` setting; `false` withdraws it). Custom mode needs a non-empty value; a registry id there (`p/…`, `r/…`, `auto`) also needs the license. While `rules` is null, scans record Semgrep as `skipped` with `note` ("Semgrep skipped: choose a rules source in Settings") and `GET /api/tools` reports semgrep `configured=false`. Nothing is accepted automatically, including on upgrade. `SEMGREP_RULES` (+ `SEMGREP_RULES_LICENSE_ACCEPTED`) from env wins and makes this read-only.
- `POST /api/setup` also takes optional `semgrep` (same shape) from the first-run wizard's license checkbox.

### About (ADMIN+SA)
- `GET /api/about` -> `{name, version, license | null, scanners:[{id, name, desc, component, spdx, url, licenseUrl, note?, noteUrl?}], runtime:[{name, version, license, url, licenseUrl}], notices, trademark}`. Scanner licenses come from `license` on each catalog item; npm licenses are read from `node_modules/<pkg>/package.json` at runtime.
- `GET /api/about/notices` -> `THIRD_PARTY_NOTICES.md` as text (copied to `/app/THIRD_PARTY_NOTICES.md` in the image).

### Projects and repos
- `GET /api/projects` -> `[{id, name, repos:[repoSummary]}]`
  - `repoSummary` = `{id, name, lang, branch, gitUrl, schedule, lastScan: scanSummary | null, running: bool}`
- `POST /api/projects` `{name}`; `PATCH /api/projects/:id` `{name}`; `DELETE /api/projects/:id` (409 if it still has repos)
- `POST /api/repos` `{projectId, name, lang, branch, gitUrl?, tools?, schedule?}` -> `{repo, token}`. name `^[a-z0-9._-]{2,60}$`, unique.
- `GET /api/repos/:id` -> `repo` = `{id, name, projectId, projectName, lang, branch, gitUrl, tools: [id] | null, schedule: "none"|"daily", tokenHint, createdAt, gate, scanRefs: {branches: [pattern], tags: [pattern], prs: bool}}`. `tools=null` means all installed tools. `tokenHint` like `shr_…a1b2`.
- `PATCH /api/repos/:id` partial of `{name, projectId, lang, branch, gitUrl, tools, schedule, gate, scanRefs}`. `scanRefs` lists are arrays or comma separated text; `*` matches any text. Empty `branches` = only `branch`; empty `tags` = no tags.
- `DELETE /api/repos/:id`
- `POST /api/repos/:id/token` -> `{token}` (old token stops working). The full token is only returned here and on create; only a hash is stored.
- `GET /api/repos/:id/scans` -> `[scanSummary]` newest first (max 100). `?kind=branch|tag|pr&ref=` for one history line (ref = branch, PR source branch or tag pattern), `?of=<num>` for the line of that scan.
- `GET /api/repos/:id/refs` -> `[{kind, ref, count, main, last: scanSummary}]` every history line, main branch first, then branches, PRs, tags.
- `POST /api/repos/:id/scan` `{branch?}` -> `{scan: scanSummary}`. Needs `gitUrl`; 400 otherwise.

`scanSummary` = `{id, num, status, trigger, branch, commit, refType: branch|tag|pr, baseBranch, refGroup, startedAt, finishedAt, durationMs, counts, openCount, newCount, fixedCount, error}`. `status`: `queued | running | done | failed`. `trigger`: `ci | manual | schedule | upload`. `counts` = open findings per severity. `num` counts up per repo starting at 1.

### Scan detail
- `GET /api/scans/:id` -> `{...scanSummary, repoId, prev: {id, num} | null, runs:[run], findings:[finding]}`
  - `run` = `{tool, status: "ok"|"failed"|"skipped", durationMs, count, note}`
  - `finding` = `{id, severity, category, title, location, file, line, pkg, version, rules:[{tool, id}], tools:[toolId], fix, description, snippet, refs:[url], status: "new"|"existing"|"fixed", firstSeenNum}`
  - `category`: `Vulnerability | Secret | Bug | Code smell | Misconfiguration | Security hotspot`
  - `location`: `file:line` or `pkg@version`
  - `snippet`: `{start, lines:[string], hl}` (hl = highlighted line number) or null
  - fixed findings (present in the previous scan, gone now) are included with `status:"fixed"` and are not part of `counts`.

### Reports and share links

A report is a read-only, printable view of one scan for customers. The same report page serves export (logged-in users) and share links.

`reportOptions` = `{title?, preparedFor?, minSeverity: "critical"|"high"|"medium"|"low"|"info" (default "low"), includeFixed: bool (default false), includeSnippets: bool (default true)}`

- `GET /api/scans/:id/report?minSeverity=&includeFixed=&includeSnippets=&title=&preparedFor=` (any logged-in user) -> `report`
- `report` = `{title, preparedFor, generatedAt, repo:{name, projectName, lang, branch}, scan:{num, commit, branch, trigger, startedAt, finishedAt, durationMs}, prev:{num}|null, summary:{counts, openCount, newCount, fixedCount, newBySeverity}, runs:[run], findings:[finding filtered by options, sorted by severity then status new first], options}`. No internal ids beyond what is shown, no tokens, no user names.
- Share links (create/list/revoke: ADMIN, SA, QA):
  - `POST /api/scans/:id/shares` `{mode: "internal"|"password", password? (>= 8, required for password mode), expiresInDays?: 1-365 | null, options: reportOptions}` -> `{share}`
  - `GET /api/scans/:id/shares` -> `[share]` (active and expired, newest first)
  - `DELETE /api/shares/:id` -> `{ok:true}` (revoked links stop working immediately)
  - `share` = `{id, mode, url, createdAt, createdBy, expiresAt|null, revoked, lastViewedAt|null, views, options}`. `url` = `<serverUrl>/s/<token>`; the token (`shs_` + 24 random bytes base64url) is only returned in `url` on create. Only its sha256 is stored, so the list shows `url: null` and a `tokenHint` instead.
- Public viewer (no session needed for the page itself):
  - `GET /s/:token` serves `public/report.html` (SPA fallback must not catch it).
  - `GET /api/share/:token` -> `{report, mode}` when allowed. Internal mode needs a valid session (any active user) else 401 `{code:"LOGIN_REQUIRED"}`. Password mode needs the unlock cookie else 401 `{code:"PASSWORD_REQUIRED"}`. Unknown/revoked -> 404, expired -> 410. Each successful view updates `views` and `lastViewedAt`.
  - `POST /api/share/:token/unlock` `{password}` -> `{ok:true}` and sets httpOnly cookie `sh_share_<shareId>` (HMAC-signed with a server secret stored in the db, valid 12 hours, path `/`). Wrong password -> 401. Rate limit: 5 failed attempts per share per IP per 15 minutes -> 429.
  - The login page accepts `#login?next=/s/<token>` (frontend) so internal links return to the report after login.
- `public/report.html`: standalone printable page (A4 print CSS, light theme only for print, page breaks between severity groups, header with title / prepared for / repo / scan date / commit, summary block with severity breakdown, scanner run table, findings with fix + references + optional snippet, footer "Created by ScanHub · <generatedAt>"). Modes: `/s/<token>` (share) and `/report.html?scan=<id>&...options` (export, needs session). Buttons (hidden in print): "Save as PDF" (window.print) and "Download HTML" (saves the rendered page as a self-contained file). Password prompt and login prompt states for share mode.

### CI gate (block or report only)

Each repo stores its gate, chosen when connecting CI and changeable later without touching the pipeline:
`gate = {mode: "block" | "report", severities: ["critical","high"] (default), scope: "new" | "open" (default "new")}`.
- `repo` gains `gate`; `POST /api/repos` and `PATCH /api/repos/:id` accept it. Default for new repos: `{mode:"block", severities:["critical","high"], scope:"new"}`.
- `POST /api/v1/scan` and `/api/v1/reports` with `wait=1` apply the repo gate. `block`: 422 when matching findings exist (new ones at those severities, or all open ones for scope `open`). `report`: always 200. The query `fail_on=` still overrides for one call (kept for compatibility), and `gate=report` forces report mode for one call.
- Response `gate` = `{mode, severities, scope, failed, matched: {critical, high, ...}, reason}`.
- With header `Accept: text/plain` the CI endpoints return only `summaryText` as the body (same status codes), which is what the snippets use so CI logs stay readable.
- Every response with `wait=1` also returns `summaryText`: a short multi-line plain-text summary (text + numbers + scan url) that the snippets print to the CI log, e.g. via `curl ... | tee` (the snippets print the body on both success and failure).
- Snippets and auto-setup files no longer hard-code `fail_on`; they rely on the repo gate. Auto-setup takes `gate` instead of `failOn` and saves it on the repo.

### CI API (Bearer repo token)
`Authorization: Bearer shr_...` identifies the repo. No session needed.

- `GET /api/v1/check?kind=branch|tag|pr&branch=<name>&base=<PR target>` -> whether the repo's `scanRefs` cover this ref. `Accept: text/plain`: first line `scan` or `skip` (then the reason). JSON: `{skipped, kind, ref, reason?}`. Generated pipelines call it before uploading.
- `POST /api/v1/scan?kind=&branch=&base=&commit=&tools=a,b&wait=1&fail_on=critical,high` body = gzip tar of the source (`Content-Type: application/gzip`, streamed, size limit `MAX_UPLOAD_MB`). Creates a scan with `trigger=ci`, runs the repo's tools on the uploaded source. With `kind`, a ref the repo does not scan returns 200 `{skipped: true, reason}` (text: `skip ...`) without scanning. Without `kind` (pipelines made before branch rules) it always scans, as a branch.
  - new / fixed compare with: a branch's previous scan of the same branch; a PR's latest scan of `base` (default the repo branch); a tag's previous tag in the same pattern (`ref_group`, e.g. `sit_v*`).
  - without `wait`: `202 {scanId, num, status, url}`
  - with `wait=1`: waits up to 30 minutes, returns `{scanId, num, status, url, counts, newCount, fixedCount, newBySeverity:{critical,...}, gate:{failed, reason}}`. If `fail_on` is set and the scan has new findings at those severities, the response status is **422** (so `curl --fail-with-body` fails the build). Scan failure -> 500.
- `POST /api/v1/reports` JSON `{branch, commit, kind?, base?, reports:[{tool, data}]}` -> same response as above (processed synchronously). `tool`: `trivy | semgrep | gitleaks | grype | checkov | dependency-check | sonarqube-issues | sarif`. Query `fail_on` works the same. For teams that already run scanners in CI.
- `GET /api/v1/scans/:id` -> scanSummary + `url`

Example used in the UI snippets:

```sh
tar --exclude=.git -czf - . | curl --fail-with-body -sS -X POST -T - \
  -H "Authorization: Bearer $SCANHUB_TOKEN" -H "Content-Type: application/gzip" \
  "$SCANHUB_URL/api/v1/scan?branch=$BRANCH&commit=$COMMIT&wait=1&fail_on=critical,high"
```

## Single image

One `Dockerfile` builds one image that contains everything: the server, PostgreSQL 16, and every scanner pre-installed at build time under `/opt/scanhub/tools` (trivy, grype, gitleaks, semgrep venv, checkov venv, OWASP Dependency-Check, sonar-scanner). The entrypoint (`docker/entrypoint.sh`, run by tini) decides what to start from env:

- `DATABASE_URL` empty -> initialise `PGDATA=/data/postgres` on first run (random password stored in `/data/postgres/.scanhub-pw`, listen on 127.0.0.1 only), start PostgreSQL inside the container, wait until ready, set `DATABASE_URL` for the server. Stop PostgreSQL cleanly on SIGTERM.
- `DATABASE_URL` set -> do not start the bundled PostgreSQL.
- `SONAR_URL` + `SONAR_TOKEN` set -> SonarQube is configured from env on start (shown as "Set from env" in settings, the form is read-only for those fields). Not set -> the settings form is used.
- `NVD_API_KEY` set -> used by Dependency-Check, same read-only rule.

Scanners: the setup wizard and settings *enable / disable* tools (instant, works offline) because they are already in the image. "Update" installs a newer version into `DATA_DIR/tools/<id>` (atomic, see below) which then takes precedence over the built-in one; "Use the version bundled with the image" removes the override. `GET /api/tools` adds `{enabled, source: "image"|"updated", imageVersion}`; `installed` stays true for built-in tools. `POST /api/tools/:id/enable`, `POST /api/tools/:id/disable`, `POST /api/tools/:id/reset` (drop override). `DELETE /api/tools/:id` = disable + drop override. The sonarqube tool shows `configured=false` with `needsConfig` until URL+token exist (env or settings).

### One-file setup

`docker-compose.yml` is the only file a user edits. It has a single `scanhub` service (`image: ghcr.io/satangbudsai/scanhub:latest`, built and pushed by `.github/workflows/image.yml` for linux/amd64 and linux/arm64; `docker-compose.build.yml` builds it locally as `scanhub:latest` instead), one named volume for `/data`, port 8080, `restart: unless-stopped`, and every setting written inline under `environment:` with a short English comment each. Required lines are at the top (`SCANHUB_ADMIN_USER`, `SCANHUB_ADMIN_PASSWORD`, `SCANHUB_URL`); every optional one is present but commented out (`DATABASE_URL`, `SONAR_URL`, `SONAR_TOKEN`, `SEMGREP_RULES`, `SEMGREP_RULES_LICENSE_ACCEPTED`, `NVD_API_KEY`, `GITHUB_TOKEN`, `GITHUB_API_URL`, `GITLAB_URL`, `GITLAB_TOKEN`, `TZ`, `SCAN_CONCURRENCY`, `MAX_UPLOAD_MB`). No `.env` file is needed (a `.env` still works through normal compose variable substitution). `docker compose up -d` is the whole install. Running without compose: `docker run -d -p 8080:8080 -e SCANHUB_ADMIN_PASSWORD=... -e SCANHUB_URL=... -v scanhub-data:/data scanhub`.

## Git providers and one-click CI setup

Connections to GitHub (github.com or Enterprise) and GitLab (gitlab.com or self-hosted) let ScanHub set up CI for a repo by itself.

- Connections (ADMIN): `{id, type: "github"|"gitlab", name, baseUrl, tokenSet, fromEnv, account, lastError}`. `baseUrl` = API root (`https://api.github.com`, `https://ghe.example.com/api/v3`, `https://gitlab.com`, `https://gitlab.example.com`). Tokens are encrypted at rest (AES-256-GCM, key from the server secret stored in the db). Env creates read-only connections on start: `GITHUB_TOKEN` (+ optional `GITHUB_API_URL`) and `GITLAB_URL` + `GITLAB_TOKEN`.
  - `GET /api/integrations` (ADMIN, SA; never returns tokens), `POST /api/integrations` (ADMIN) `{type, name, baseUrl, token}`, `PATCH /api/integrations/:id`, `DELETE /api/integrations/:id`
  - `POST /api/integrations/:id/test` -> `{ok, account, scopesOk, missing:[string], error}` (checks the token can write contents, PRs/MRs and secrets/variables)
  - `GET /api/integrations/:id/repos?q=` (ADMIN, SA) -> `[{fullName, defaultBranch, cloneUrl, webUrl, private}]`, max 50, sorted by last activity
  - Token permissions shown in the UI: GitHub fine-grained PAT with Contents, Pull requests, Secrets, Variables, Workflows = read/write, Metadata = read (classic: `repo`, `workflow`); GitLab `api` scope with Maintainer role.
- `POST /api/repos/:id/auto-setup` (ADMIN, SA) `{integrationId, remoteRepo, branch?, gate, tools?: [id] | null, mode: "pr" | "commit"}` -> `{ok, prUrl | null, commitUrl | null, steps:[{key, ok, message}]}`. Steps, each reported:
  1. `token`: rotate the ScanHub repo token (the old one stops working)
  2. `secret`: GitHub: Actions secret `SCANHUB_TOKEN` (sealed box with the repo public key; use `tweetnacl` + `blakejs` or `libsodium-wrappers`) and Actions variable `SCANHUB_URL`. GitLab: project CI/CD variables `SCANHUB_TOKEN` (masked) and `SCANHUB_URL`.
  3. `file`: GitHub: `.github/workflows/scanhub.yml`. GitLab: `.gitlab/scanhub.yml`, plus `include: - local: .gitlab/scanhub.yml` added to `.gitlab-ci.yml` (created if missing; existing content kept, the include is added only once). The files use the same curl pattern as the snippets but read `SCANHUB_URL` / `SCANHUB_TOKEN` from the variables.
  4. `pr`: mode `pr` (default) pushes branch `scanhub/setup` and opens (or updates) a PR / MR titled "Add ScanHub scan". Mode `commit` commits straight to the default branch.
  5. `link`: saves `remote = {integrationId, fullName}` on the repo and fills `gitUrl` / `branch` if empty.
  A failed step stops the rest; earlier steps are not rolled back, the response says what was done.
- Repos linked to a connection use its token for `git clone` (scheduled / manual scans of private repos). `repo` gains `remote: {integrationId, fullName, webUrl} | null`.
- The add-repo modal can pick a repo from a connection to prefill name, git URL and branch, then offer auto-setup right away.

## Scanning

1. Source: CI upload is extracted with `tar -xzf` into `DATA_DIR/work/<scanId>`; git repos are cloned with `git clone --depth 1 --branch <branch>`. The work dir is deleted after the scan.
2. Each selected and installed tool runs with a timeout (30 min) and writes JSON. A tool that is not installed, not configured (sonarqube) or not applicable is recorded as `skipped` with a note. A crash is `failed` with the last stderr lines as note; the scan still completes with the other tools.
3. Parsers turn each report into normalized findings. Merge dedupes across tools: dependency findings by `rule id (CVE/GHSA) + package + version`; others by `category + file + line`. A merged finding keeps every tool and rule id.
4. Fingerprint (for new / fixed): dependencies `rule + package`; others `category + file + trimmed source line text` (falls back to line number), so moved lines are still matched.
5. Diff against the previous `done` scan of the same repo: `new`, `existing` (keeps `firstSeenNum`), `fixed`.
6. Snippets: up to 3 lines around the line, read from the source while it is still on disk.

### Tool commands (inside the container)
- trivy: `trivy fs --scanners vuln,secret,misconfig --format json --output out.json --cache-dir $DATA/cache/trivy <src>`
- semgrep: `semgrep scan --config <rules> --json --output out.json --metrics off <src>` (venv)
- gitleaks: `gitleaks dir <src> --report-format json --report-path out.json --exit-code 0`
- grype: `grype dir:<src> -o json --file out.json` (`GRYPE_DB_CACHE_DIR=$DATA/cache/grype`)
- checkov: `checkov -d <src> -o json --quiet --compact --soft-fail` (stdout, venv)
- dependency-check: `dependency-check.sh --scan <src> --format JSON --out <dir> --data $DATA/cache/dependency-check --noupdate [--nvdApiKey]`
- sonarqube: `sonar-scanner -Dsonar.projectKey=scanhub_<repo> -Dsonar.sources=. -Dsonar.host.url=<url> -Dsonar.token=<token> -Dsonar.scm.disabled=true`, wait for the CE task from `.scannerwork/report-task.txt`, then read `/api/issues/search` (unresolved) and `/api/hotspots/search` (TO_REVIEW).

### Install sources (linux amd64 / arm64)
- trivy, grype, gitleaks: latest GitHub release tarball into `DATA_DIR/tools/<id>/`
- semgrep, checkov: `python3 -m venv DATA_DIR/tools/<id>/venv && pip install -U <pkg>`
- dependency-check: latest GitHub release zip (needs the JRE in the image)
- sonarqube: sonar-scanner CLI zip from binaries.sonarsource.com (bundles its own JRE)

Install and update are atomic: download / build into `DATA_DIR/tools/<id>.new`, verify by running the version command, then swap with the old dir (old kept as `<id>.old` until the swap succeeds, then removed). A failed update leaves the previous version working and logs the error. A tool is never swapped while a scan is using it (update waits for running scans to finish, max 30 min).

### Schedule
- Every day at `schedule.time` (if enabled): update every installed tool to its latest version, then update DBs if `updateDb` (`trivy --download-db-only`, `grype db update`, `dependency-check --updateonly`). Result saved as `lastUpdateRun` + tool log.
- Every day at `scanTime`: queue a scan for each repo with `schedule="daily"` and a `gitUrl` (`trigger=schedule`).
- Every day: delete scans older than `retentionDays` (0 = keep forever), always keeping the latest scan of each repo.
- On start: scans left `queued`/`running` become `failed` ("server restarted").
