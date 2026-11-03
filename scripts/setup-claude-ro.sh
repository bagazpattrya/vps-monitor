#!/usr/bin/env bash
# Prepares the unprivileged user that runs Claude for the AI chat. Run as root on the VPS:
#   sudo scripts/setup-claude-ro.sh [--dry-run] [CLAUDE_SRC] [MONITOR_DIR]
# --dry-run only prints what would happen and changes nothing.
set -euo pipefail

DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
CLAUDE_SRC="${1:-/home/zae/.local/bin/claude}"
MONITOR_DIR="${2:-/var/www/vps-monitor}"
CHAT_USER="claude-ro"
DEST="/usr/local/bin/claude"

run() { echo "+ $*"; [ "$DRY" = 1 ] || "$@"; }

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || { echo "Run as root (sudo), or use --dry-run." >&2; exit 1; }
[ -e "$CLAUDE_SRC" ] || { echo "claude not found at $CLAUDE_SRC (pass the path as first argument)." >&2; exit 1; }

# 1. user without login shell, with its own home (Claude keeps its config and sessions there)
if id "$CHAT_USER" >/dev/null 2>&1; then echo "user $CHAT_USER already exists"; else run useradd -m -s /usr/sbin/nologin "$CHAT_USER"; fi

# 2. system-wide copy of the claude binary, so $CHAT_USER can run it without access to another home
run install -m 755 "$(readlink -f "$CLAUDE_SRC")" "$DEST"

# 3. $CHAT_USER must not read the monitor's data (chats, users, sessions)
run chmod o-rwx "$MONITOR_DIR/data"

cat <<MSG

Next, by hand:
  1. sudo -u $CHAT_USER -H $DEST setup-token       (prints a token; keep it secret)
  2. Set in the monitor environment (pm2 / ecosystem.config.js, not in git):
       CLAUDE_BIN=$DEST  CHAT_USER=$CHAT_USER  CHAT_HOME=/home/$CHAT_USER
       CLAUDE_CODE_OAUTH_TOKEN=<token>  SCAN_DIR=<folder with your projects>
     then: pm2 restart vps-monitor --update-env
  3. Apply the 'location /api/chat' block from nginx-monitor.conf to the live nginx config,
     then: sudo nginx -t && sudo systemctl reload nginx
  4. Verify (each command must FAIL):
       sudo -u $CHAT_USER touch <a project folder>/x
       sudo -u $CHAT_USER ls $MONITOR_DIR/data
       sudo -u $CHAT_USER cat /root/.bashrc
     Hidden projects must not be readable by $CHAT_USER either (check with sudo -u $CHAT_USER ls <hidden project>).
MSG
