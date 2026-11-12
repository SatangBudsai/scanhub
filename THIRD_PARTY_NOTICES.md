# Third-party notices

ScanHub bundles or runs the third-party software below. Each component stays under its own license; ScanHub does not change those terms. The same list is shown in the app under Settings → About and licenses (from `GET /api/about`). In the Docker image this file is at `/app/THIRD_PARTY_NOTICES.md`.

ScanHub's own license: none chosen yet (`package.json` has no `license` field).

Product names and logos belong to their owners; ScanHub is not affiliated with or endorsed by them.

## Scanners bundled in the image

Versions: the image installs the latest release of each scanner at build time (or the version pinned with the `*_VERSION` build args in the `Dockerfile`). The installed versions are recorded in `/opt/scanhub/tools/versions.json` and shown in Settings → Scanners.

| Component | What it does | License (SPDX) | Project |
| --- | --- | --- | --- |
| Trivy | Vulnerabilities in dependencies, secrets, IaC/Dockerfile misconfigurations | Apache-2.0 | https://github.com/aquasecurity/trivy |
| Grype | Vulnerabilities in dependencies and the filesystem | Apache-2.0 | https://github.com/anchore/grype |
| Gitleaks | Secrets and credentials leaked in code | MIT | https://github.com/gitleaks/gitleaks |
| Checkov | Misconfigurations in Terraform, Kubernetes, Dockerfile and CI config | Apache-2.0 | https://github.com/bridgecrewio/checkov |
| OWASP Dependency-Check | Matches dependencies against CVEs from NVD | Apache-2.0 | https://github.com/jeremylong/DependencyCheck |
| Semgrep (engine) | SAST with customizable rules | LGPL-2.1 | https://github.com/semgrep/semgrep |
| SonarQube Scanner CLI | Sends code to your own SonarQube server for analysis | LGPL-3.0 | https://github.com/SonarSource/sonar-scanner-cli |

License texts: https://spdx.org/licenses/Apache-2.0.html, https://spdx.org/licenses/MIT.html, https://spdx.org/licenses/LGPL-2.1.html, https://spdx.org/licenses/LGPL-3.0.html

### Semgrep rules

The Semgrep engine is LGPL-2.1, but the rules in the Semgrep Registry (for example `p/default`) are under the **Semgrep Rules License v1.0**: https://semgrep.dev/legal/rules-license. It allows use only for your own internal business purposes and does not allow distributing the rules or making them available to others as a service.

ScanHub does not ship these rules and does not accept this license for you. Semgrep runs only after the person who installs ScanHub either accepts the license and picks the registry rules (Settings, first-time setup, or `SEMGREP_RULES=p/default` with `SEMGREP_RULES_LICENSE_ACCEPTED=true`), or sets custom rules. Until then Semgrep is skipped in scans.

The SonarQube server itself is not bundled; ScanHub connects to a server you run.

## Runtime components

| Component | Version | License (SPDX) | Project |
| --- | --- | --- | --- |
| PostgreSQL | 16 (from apt.postgresql.org) | PostgreSQL | https://www.postgresql.org |
| Node.js | 22 (`node:22-bookworm-slim` base image) | MIT | https://nodejs.org |

npm `dependencies` from `package.json` (licenses taken from each package's `package.json` in `node_modules`; versions from `package-lock.json` at the time of writing):

| Package | Version | License (SPDX) | Project |
| --- | --- | --- | --- |
| blakejs | 1.2.1 | MIT | https://github.com/dcposch/blakejs |
| express | 4.22.3 | MIT | https://expressjs.com |
| pg | 8.23.1 | MIT | https://github.com/brianc/node-postgres |
| tweetnacl | 1.0.3 | Unlicense | https://tweetnacl.js.org |

The About page reads these values from `node_modules` at runtime, so it always matches what is installed. Transitive npm dependencies, the Debian base image packages, OpenJDK (used by Dependency-Check) and Python (used by Semgrep and Checkov) keep their own licenses as shipped by their maintainers.
