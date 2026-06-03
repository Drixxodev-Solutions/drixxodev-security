#!/bin/bash
# SessionStart hook — provisions a working dev environment for Claude Code on the web.
#
# Brings up everything the app and tests need:
#   1. npm dependencies
#   2. a running local PostgreSQL 16 cluster
#   3. the `drixxodev` database + role matching .env.example
#   4. a .env with a generated TOKEN_ENCRYPTION_KEY (created once, never overwritten)
#   5. the Prisma client + schema applied via `prisma db push`
#
# Without this, DB-backed pages (e.g. /dashboard) and any DB-touching test fail with
# "Can't reach database server at localhost:5432". Idempotent — safe to re-run.
set -euo pipefail

# Web-only: local dev machines run their own Postgres and manage their own .env.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "[session-start] not a remote session; skipping provisioning."
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Connection details — must match .env.example's DATABASE_URL.
DB_USER="user"
DB_PASSWORD="password"
DB_NAME="drixxodev"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"

echo "[session-start] installing npm dependencies..."
npm install --no-audit --no-fund

echo "[session-start] starting PostgreSQL 16 cluster..."
# pg_ctlcluster exits non-zero if already running; tolerate that, then confirm readiness.
pg_ctlcluster 16 main start 2>/dev/null || true
for i in $(seq 1 30); do
  if pg_isready -q -h localhost -p 5432; then break; fi
  sleep 1
done
pg_isready -h localhost -p 5432

echo "[session-start] ensuring role and database exist..."
# Run as the postgres superuser (owns the cluster). Write the SQL to a file via a
# quoted heredoc so $$ dollar-quoting survives (su -c would otherwise expand it).
# Identifiers are hardcoded to match .env.example's DATABASE_URL (user/password/drixxodev).
INIT_SQL="$(mktemp -p /tmp dvxx_init.XXXXXX)"
cat > "$INIT_SQL" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'user') THEN
    CREATE ROLE "user" LOGIN PASSWORD 'password';
  END IF;
END
$$;
ALTER ROLE "user" CREATEDB;
SQL
chmod 644 "$INIT_SQL"
su -s /bin/bash postgres -c "psql -v ON_ERROR_STOP=1 -f '${INIT_SQL}'"
rm -f "$INIT_SQL"
if ! su -s /bin/bash postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1; then
  su -s /bin/bash postgres -c "createdb -O '${DB_USER}' '${DB_NAME}'"
fi

# Seed .env from the example on first run (kept thereafter), then reconcile the
# managed keys against the environment below.
if [ ! -f .env ]; then
  echo "[session-start] creating .env from .env.example..."
  cp .env.example .env
fi

# Reconcile .env with the container environment every session.
#
# The web environment's configured env vars are the single source of truth for
# secrets (§7.4). Precedence per managed key:
#   1. value from the environment (operator-configured) — always wins
#   2. an existing real value already in .env (e.g. operator-pasted) — preserved
#   3. otherwise a safe default:
#        - DATABASE_URL          -> the local cluster we just provisioned
#        - TOKEN_ENCRYPTION_KEY  -> freshly generated 32-byte key
#        - APP_BASE_URL          -> http://localhost:3000
#        - Clerk/LLM/OAuth keys  -> BLANK (never the example placeholder)
#
# Blanking unset keys matters: the literal pk_test_.../sk_test_... placeholders
# make @clerk/nextjs throw at boot. Empty instead makes Clerk fall back to its
# keyless dev mode, so /dashboard reaches a working sign-in instead of crashing.
echo "[session-start] reconciling .env with environment..."
node - "$DATABASE_URL" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [databaseUrl] = process.argv.slice(2);

const parse = (s) => Object.fromEntries(
  s.split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);
const placeholders = parse(fs.readFileSync('.env.example', 'utf8'));
let env = fs.readFileSync('.env', 'utf8');

// A current .env value is "real" only if it's non-empty and not the example placeholder.
const real = (name, val) => val && val.trim() && val !== placeholders[name];
const current = (name) => {
  const m = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1] : undefined;
};
const setVar = (name, value) => {
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, line) : env + (env.endsWith('\n') ? '' : '\n') + line + '\n';
};
// env var -> else existing real value -> else fallback
const reconcile = (name, fallback) => {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return setVar(name, fromEnv);
  const cur = current(name);
  if (real(name, cur)) return; // preserve operator-pasted value
  setVar(name, fallback);
};

// Local-cluster values we provision ourselves.
setVar('DATABASE_URL', databaseUrl);
reconcile('TOKEN_ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex'));
reconcile('APP_BASE_URL', 'http://localhost:3000');

// Secrets/credentials: env value, else preserved real value, else BLANK.
for (const name of [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET',
  'OPERATOR_ALERT_EMAIL',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY',
]) {
  reconcile(name, '');
}

fs.writeFileSync('.env', env);
NODE

# Expose DB connection + token key to the agent's shell (Prisma CLI, ad-hoc scripts).
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export DATABASE_URL='${DATABASE_URL}'"
    grep '^TOKEN_ENCRYPTION_KEY=' .env | sed "s/^/export /"
  } >> "$CLAUDE_ENV_FILE"
fi

echo "[session-start] generating Prisma client and applying schema..."
export DATABASE_URL
npx prisma generate
# No migration baseline exists yet (prisma/ has only schema.prisma), so use db push
# to sync the schema — the quick-start path documented in DEPLOYMENT.md §5.
npx prisma db push --skip-generate

echo "[session-start] done. Postgres is up and schema is applied."
