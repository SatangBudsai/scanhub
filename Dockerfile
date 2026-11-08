# One image with everything: ScanHub server, PostgreSQL 16 and every scanner.
# The bundled PostgreSQL only starts when DATABASE_URL is empty (see docker/entrypoint.sh).
FROM node:22-bookworm-slim

ARG TARGETARCH
# "latest" or a pinned version for each scanner (semgrep / checkov: empty = latest)
ARG TRIVY_VERSION=latest
ARG GRYPE_VERSION=latest
ARG GITLEAKS_VERSION=latest
ARG DEPCHECK_VERSION=latest
ARG SONAR_SCANNER_VERSION=latest
ARG SEMGREP_VERSION=
ARG CHECKOV_VERSION=

# Runtimes: git (clone), python (semgrep, checkov), java (dependency-check), PostgreSQL 16 from PGDG
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg unzip tar python3 python3-venv python3-pip openjdk-17-jre-headless tini \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && mkdir -p /etc/postgresql-common && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16 \
 && rm -rf /var/lib/apt/lists/*

# Scanners, pre-installed under /opt/scanhub/tools (versions in versions.json)
COPY docker/install-tools.sh /tmp/install-tools.sh
RUN TARGETARCH="$TARGETARCH" TRIVY_VERSION="$TRIVY_VERSION" GRYPE_VERSION="$GRYPE_VERSION" GITLEAKS_VERSION="$GITLEAKS_VERSION" \
    DEPCHECK_VERSION="$DEPCHECK_VERSION" SONAR_SCANNER_VERSION="$SONAR_SCANNER_VERSION" SEMGREP_VERSION="$SEMGREP_VERSION" \
    CHECKOV_VERSION="$CHECKOV_VERSION" bash -c "sed -i 's/\r$//' /tmp/install-tools.sh && bash /tmp/install-tools.sh" \
 && rm /tmp/install-tools.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    TZ=Asia/Bangkok \
    HOME=/data/home \
    SEMGREP_SEND_METRICS=off \
    SCANHUB_IMAGE_TOOLS=/opt/scanhub/tools

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh \
 && useradd --system --uid 10001 --create-home --home-dir /data/home scanhub \
 && mkdir -p /data && chown -R scanhub:scanhub /data
USER scanhub
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
