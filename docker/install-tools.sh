#!/usr/bin/env bash
# Installs every scanner into /opt/scanhub/tools at image build time.
# Versions: "latest" (default) resolves the latest GitHub / PyPI release; set a version to pin it.
set -euo pipefail

DEST=/opt/scanhub/tools
ARCH="${TARGETARCH:-}"
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
fi
case "$ARCH" in amd64|arm64) ;; *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; esac
echo "installing scanners for linux/$ARCH into $DEST"

fetch() { curl -fsSL --retry 6 --retry-delay 5 --retry-all-errors -o "$2" "$1"; }

# Tag of the latest GitHub release, read from the redirect (no API rate limit)
latest_tag() {
  curl -fsSI --retry 6 --retry-delay 5 --retry-all-errors "https://github.com/$1/releases/latest" \
    | tr -d '\r' | awk 'tolower($1)=="location:" {print $2}' | tail -n1 | sed 's#.*/tag/##'
}
tag_for() { # repo, requested version
  if [ "$2" = "latest" ] || [ -z "$2" ]; then latest_tag "$1"; else
    case "$2" in v*) echo "$2" ;; *) echo "$3$2" ;; esac
  fi
}

TMP=$(mktemp -d)
mkdir -p "$DEST"

# trivy
tag=$(tag_for aquasecurity/trivy "${TRIVY_VERSION:-latest}" v); v=${tag#v}
a=$([ "$ARCH" = arm64 ] && echo ARM64 || echo 64bit)
fetch "https://github.com/aquasecurity/trivy/releases/download/$tag/trivy_${v}_Linux-${a}.tar.gz" "$TMP/trivy.tgz"
mkdir -p "$DEST/trivy" && tar -xzf "$TMP/trivy.tgz" -C "$DEST/trivy"

# grype
tag=$(tag_for anchore/grype "${GRYPE_VERSION:-latest}" v); v=${tag#v}
fetch "https://github.com/anchore/grype/releases/download/$tag/grype_${v}_linux_${ARCH}.tar.gz" "$TMP/grype.tgz"
mkdir -p "$DEST/grype" && tar -xzf "$TMP/grype.tgz" -C "$DEST/grype"

# gitleaks
tag=$(tag_for gitleaks/gitleaks "${GITLEAKS_VERSION:-latest}" v); v=${tag#v}
a=$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)
fetch "https://github.com/gitleaks/gitleaks/releases/download/$tag/gitleaks_${v}_linux_${a}.tar.gz" "$TMP/gitleaks.tgz"
mkdir -p "$DEST/gitleaks" && tar -xzf "$TMP/gitleaks.tgz" -C "$DEST/gitleaks"

# OWASP Dependency-Check (runs on the JRE from the image)
tag=$(tag_for jeremylong/DependencyCheck "${DEPCHECK_VERSION:-latest}" v); v=${tag#v}
fetch "https://github.com/jeremylong/DependencyCheck/releases/download/$tag/dependency-check-${v}-release.zip" "$TMP/dc.zip"
mkdir -p "$DEST/dependency-check" && unzip -q "$TMP/dc.zip" -d "$DEST/dependency-check"

# sonar-scanner CLI (bundles its own JRE)
tag=$(tag_for SonarSource/sonar-scanner-cli "${SONAR_SCANNER_VERSION:-latest}" ""); v=${tag#v}
a=$([ "$ARCH" = arm64 ] && echo aarch64 || echo x64)
fetch "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${v}-linux-${a}.zip" "$TMP/sonar.zip"
mkdir -p "$DEST/sonarqube" && unzip -q "$TMP/sonar.zip" -d "$DEST/sonarqube"

# semgrep and checkov in their own venvs
for pkg in semgrep checkov; do
  ver_var=$(echo "${pkg}_VERSION" | tr '[:lower:]' '[:upper:]')
  ver="${!ver_var:-}"
  python3 -m venv "$DEST/$pkg/venv"
  "$DEST/$pkg/venv/bin/pip" install --quiet --no-cache-dir --disable-pip-version-check "$pkg${ver:+==$ver}"
done

chmod -R a+rX "$DEST"
find "$DEST" -path '*/bin/*' -type f -exec chmod a+x {} +

# Record the versions for GET /api/tools (imageVersion)
ver() { "$@" 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1 || true; }
bin() { find "$DEST/$1" -type f -name "$2" -path "$3" | head -n1; }
TRIVY=$(ver "$DEST/trivy/trivy" --version)
GRYPE=$(ver "$DEST/grype/grype" version)
GITLEAKS=$(ver "$DEST/gitleaks/gitleaks" version)
SEMGREP=$(ver "$DEST/semgrep/venv/bin/semgrep" --version)
CHECKOV=$(ver "$DEST/checkov/venv/bin/checkov" --version)
DC=$(ver "$(bin dependency-check dependency-check.sh '*/bin/*')" --version)
SONAR=$(ver "$(bin sonarqube sonar-scanner '*/bin/*')" --version)
for x in TRIVY GRYPE GITLEAKS SEMGREP CHECKOV DC SONAR; do
  if [ -z "${!x}" ]; then echo "could not read the $x version: install failed" >&2; exit 1; fi
done
cat > "$DEST/versions.json" <<EOF
{"trivy":"$TRIVY","grype":"$GRYPE","gitleaks":"$GITLEAKS","semgrep":"$SEMGREP","checkov":"$CHECKOV","dependency-check":"$DC","sonarqube":"$SONAR"}
EOF
cat "$DEST/versions.json"
rm -rf "$TMP" /root/.cache /root/.semgrep
