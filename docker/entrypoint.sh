#!/usr/bin/env bash
# Starts ScanHub. With DATABASE_URL empty it also runs the PostgreSQL bundled in the image
# (data in /data/postgres, listening on 127.0.0.1 only) and stops it cleanly on SIGTERM.
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
BUNDLED=0

stop_pg() {
  if [ "$BUNDLED" = 1 ]; then
    echo "[scanhub] stopping bundled PostgreSQL"
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w -t 60 stop >/dev/null 2>&1 || true
  fi
}

if [ -z "${DATABASE_URL:-}" ]; then
  BUNDLED=1
  export PGDATA=/data/postgres
  PWFILE="$PGDATA/.scanhub-pw"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "[scanhub] first start: initialising bundled PostgreSQL in $PGDATA"
    mkdir -p "$PGDATA"
    chmod 700 "$PGDATA"
    PW=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)
    TMPPW=$(mktemp)
    printf '%s' "$PW" > "$TMPPW"
    "$PGBIN/initdb" -D "$PGDATA" -U scanhub --pwfile="$TMPPW" --auth=scram-sha-256 -E UTF8 --locale=C.UTF-8 >/dev/null
    rm -f "$TMPPW"
    printf '%s' "$PW" > "$PWFILE"
    chmod 600 "$PWFILE"
    cat >> "$PGDATA/postgresql.conf" <<'EOF'
# ScanHub: only reachable from inside the container
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = '/tmp'
log_min_messages = warning
EOF
  fi
  PW=$(cat "$PWFILE")
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/postgresql.log" -w -t 60 start >/dev/null
  if ! PGPASSWORD="$PW" "$PGBIN/psql" -h 127.0.0.1 -U scanhub -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'scanhub'" | grep -q 1; then
    PGPASSWORD="$PW" "$PGBIN/psql" -h 127.0.0.1 -U scanhub -d postgres -qc "CREATE DATABASE scanhub"
  fi
  export DATABASE_URL="postgres://scanhub:${PW}@127.0.0.1:5432/scanhub"
  echo "[scanhub] bundled PostgreSQL is running"
else
  echo "[scanhub] DATABASE_URL is set: using the external PostgreSQL, the bundled one is not started"
fi

node /app/server/index.js &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" 2>/dev/null || true' TERM INT

set +e
wait "$NODE_PID"
CODE=$?
# wait returns early when the trap fires; wait for node to really exit
while kill -0 "$NODE_PID" 2>/dev/null; do
  wait "$NODE_PID"
  CODE=$?
done
stop_pg
exit "$CODE"
