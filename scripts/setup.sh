#!/usr/bin/env bash
#
# Sets up or updates proton-mcp on Linux and macOS.
#
#   ./scripts/setup.sh            install: install dependencies and build
#   ./scripts/setup.sh --update   update: pull, then install and build
#
# The script never touches your credentials. It creates the credentials file
# with placeholders if it does not exist, and leaves an existing one alone.
#
# On Windows use scripts/setup.ps1 instead.

set -euo pipefail

MIN_NODE_MAJOR=24
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRED_DIR="${HOME}/.config/proton-mcp"
CRED_FILE="${CRED_DIR}/env"

MODE=install
if [[ "${1:-}" == "--update" ]]; then
  MODE=update
elif [[ -n "${1:-}" ]]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: $0 [--update]" >&2
  exit 2
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

step "Checking prerequisites"

command -v node >/dev/null 2>&1 || fail "node is not installed. proton-mcp needs Node.js ${MIN_NODE_MAJOR} or newer."
command -v npm >/dev/null 2>&1 || fail "npm is not installed."

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  fail "Node.js ${NODE_VERSION} is too old. Version ${MIN_NODE_MAJOR} or newer is required."
fi
say "node ${NODE_VERSION}, npm $(npm --version)"

cd "$REPO_ROOT"

if [[ "$MODE" == "update" ]]; then
  step "Updating the working copy"
  command -v git >/dev/null 2>&1 || fail "git is not installed, so --update cannot work."
  [[ -d .git ]] || fail "${REPO_ROOT} is not a git repository, so --update cannot work."

  if [[ -n "$(git status --porcelain)" ]]; then
    fail "There are uncommitted changes in ${REPO_ROOT}. Commit or stash them first; this script will not discard your work."
  fi
  git pull --ff-only || fail "git pull failed. Resolve it by hand and run this script again."
  say "Now at: $(git log -1 --format='%h %s')"
fi

step "Installing dependencies"
# npm ci is reproducible and needs the lockfile, which the repository has.
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

step "Building"
npm run build
[[ -f dist/server.js ]] || fail "The build did not produce dist/server.js."

step "Running the tests"
npm test

step "Credentials"
if [[ -f "$CRED_FILE" ]]; then
  say "${CRED_FILE} already exists and was left untouched."
  # The password lives in here, so a file others can read is worth a word.
  MODE_BITS="$(stat -c '%a' "$CRED_FILE" 2>/dev/null || stat -f '%Lp' "$CRED_FILE" 2>/dev/null || echo '')"
  if [[ -n "$MODE_BITS" && "$MODE_BITS" != "600" && "$MODE_BITS" != "400" ]]; then
    say "WARNING: its permissions are ${MODE_BITS}. Restrict it with: chmod 600 ${CRED_FILE}"
  fi
else
  mkdir -p "$CRED_DIR"
  umask 077
  cat > "$CRED_FILE" <<'CRED'
# Proton Mail Bridge credentials for proton-mcp.
#
# BRIDGE_PASS is the password the Bridge generates, NOT your Proton account
# password. Find it in the Bridge application under the account, or run
# "protonmail-bridge --cli" and then "info".
BRIDGE_USER=your.address@example.com
BRIDGE_PASS=replace-me

# The ports are configurable in the Bridge. Only set these if you changed them.
#BRIDGE_IMAP_PORT=1143
#BRIDGE_SMTP_PORT=1025
CRED
  chmod 600 "$CRED_FILE"
  say "Created ${CRED_FILE} with placeholders, mode 600."
  say "Edit it and put your real address and Bridge password in."
fi

step "Done"
say "Register the server with your AI client:"
say ""
say "  claude mcp add proton -- node ${REPO_ROOT}/dist/server.js"
say ""
say "For clients that use a JSON configuration:"
say ""
say '  { "mcpServers": { "proton": { "command": "node", "args": ["'"${REPO_ROOT}"'/dist/server.js"] } } }'
say ""
say "No credentials go into the client configuration. The server reads them from"
say "${CRED_FILE} itself."
say ""
say "Make sure Proton Mail Bridge is running and unlocked, then try asking your"
say "assistant which mail folders you have."
