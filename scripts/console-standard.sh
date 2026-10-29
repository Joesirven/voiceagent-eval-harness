#!/bin/bash
# Starts the standard Pipecat console: the page on 127.0.0.1:4351 and the bot on 127.0.0.1:4352.
# Needs CRM_DEV_ENV_FILE (the credential file the dev server uses) in the environment.
# Logs go to $CONSOLE_STANDARD_LOGS (default console-standard/logs). Stop with the pids it prints.
set -euo pipefail
cd "$(dirname "$0")/.."
LOGS="${CONSOLE_STANDARD_LOGS:-console-standard/logs}"
VENV="${CONSOLE_STANDARD_VENV:-/tmp/crm-console-standard-venv}"
umask 077  # logs and pid files readable by this user only
mkdir -p "$LOGS"
[ -n "${CRM_DEV_ENV_FILE:-}" ] || { echo "CRM_DEV_ENV_FILE is not set" >&2; exit 1; }
[ -x "$VENV/bin/python" ] || { echo "Missing $VENV. Run: uv venv --python 3.12 $VENV && uv pip install --python $VENV/bin/python -r console-standard/requirements.txt" >&2; exit 1; }
[ -d console-standard/web/node_modules ] || (cd console-standard/web && env -i "PATH=$PATH" "HOME=$HOME" pnpm install --ignore-workspace --frozen-lockfile)
for port in 4351 4352; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is already in use" >&2; exit 1; fi
done
# The page tools get no credentials and no other variables: only PATH and HOME.
PAGE_ENV=(env -i "PATH=$PATH" "HOME=$HOME")
# The harness copy that serves the prompt and agent instruction routes (loopback only), when not the default 4311.
[ -n "${CONSOLE_STANDARD_HARNESS_URL:-}" ] && PAGE_ENV+=("CONSOLE_STANDARD_HARNESS_URL=$CONSOLE_STANDARD_HARNESS_URL" "CONSOLE_STANDARD_HARNESS_PORT=${CONSOLE_STANDARD_HARNESS_URL##*:}")
(cd console-standard/web && "${PAGE_ENV[@]}" node_modules/.bin/vite build >"$LOGS/page-build.log" 2>&1)
(cd console-standard/web && nohup "${PAGE_ENV[@]}" node_modules/.bin/vite preview >"$LOGS/page.log" 2>&1 </dev/null & echo $! >"$LOGS/page.pid")
nohup node_modules/.bin/tsx console-standard/launch-bot.ts >"$LOGS/bot.log" 2>&1 </dev/null &
echo $! >"$LOGS/bot.pid"
echo "page http://127.0.0.1:4351/ (pid $(cat "$LOGS/page.pid")), bot 127.0.0.1:4352 (pid $(cat "$LOGS/bot.pid")), logs in $LOGS"
# Security notes:
# - No VITE_ variable may ever hold a credential: vite copies those into the public page.
# - The bot accepts browser calls only from http://127.0.0.1:4351, and the page forwards only /api/offer and /start.
# - The bot's WebRTC media sockets (random ports) bind to the machine's network interfaces, not only loopback;
#   a peer needs the connection credentials from a negotiated offer, so a stranger gets no session. For
#   loopback-only media, add a host firewall rule for the bot's python process.
# - The bot's environment holds the credentials and is readable by this user through ps.
