# AI Chat: VPS setup

The chat page (`/chat`, admins and superadmins) runs the `claude` CLI as an unprivileged Linux user so Claude can read project files but cannot change anything. These steps run once on the VPS. `scripts/setup-claude-ro.sh` does steps 1, 2 and the `data/` part of step 5 (run it with `--dry-run` first); the rest is manual. Spec: `docs/superpowers/specs/2026-11-03-ai-chat-design.md`.

The monitor must run as root (as it does under pm2). When it is not root, `claude` runs as the same user as the monitor, and the monitor logs a warning. Do not use that mode in production.

1. **Create the user.**
   `sudo useradd -m -s /usr/sbin/nologin claude-ro`
   Check: `ls -ld /home/claude-ro` shows owner `claude-ro`.

2. **Make `claude` executable by `claude-ro`.** Install it system-wide, or copy the binary somewhere like `/usr/local/bin/claude`. Set `CLAUDE_BIN` to that path.
   Check: `sudo -u claude-ro /usr/local/bin/claude --version` prints a version.

3. **Create the subscription token.** This uses your Claude subscription, and every admin shares its usage limits. Check Anthropic's current terms before enabling this for several people. If they do not allow it, use `ANTHROPIC_API_KEY` instead (change the env variable name in `chat.js`).
   `sudo -u claude-ro -H claude setup-token`
   Put the printed token in the monitor's environment as `CLAUDE_CODE_OAUTH_TOKEN` (pm2 env, not in git).

4. **Set the monitor environment.** Easiest and permanent: the `.env` file in the monitor folder (git-ignored; the monitor loads it at start, and variables set by pm2 take precedence). Because it holds the token, first `sudo chown root:root .env && sudo chmod 600 .env`, then edit it and `pm2 restart vps-monitor`. Variables (see `env.example`): `CLAUDE_BIN`, `CHAT_USER=claude-ro`, `CHAT_HOME=/home/claude-ro`, `CLAUDE_CODE_OAUTH_TOKEN`. Optional: `CHAT_MODELS=haiku,sonnet` limits the model dropdown (Opus uses the shared subscription limit much faster). Restart: `pm2 restart vps-monitor --update-env`.

5. **Lock down permissions.** `claude-ro` must be able to read the projects admins may see, and nothing else:
   - Project files readable (`o+r`), and not writable by `claude-ro`.
   - Hidden projects, `/root`, and the monitor's `data/` directory not readable by `claude-ro`. Because hidden projects are decided per user by keywords, any project that must stay hidden from some admins cannot be readable by `claude-ro` by path guessing alone. Claude is only given the folders of projects the user may see, so this step is the second barrier.
   Check: `sudo -u claude-ro touch /var/www/<project>/x` fails; `sudo -u claude-ro cat /root/.bashrc` fails; `sudo -u claude-ro ls /path/to/vps-monitor/data` fails.

6. **End-to-end check.** In the chat page ask "what files are in project X?" and expect an answer. Ask it to edit a file and expect a refusal with the file unchanged. As an admin with `hiddenKeywords`, ask about a hidden project and expect that it is not found.

If a check in step 5 or 6 fails, do not enable the chat for users until it is fixed.

## Saved chats and images

- Conversations are stored per user in `data/chats/<user>/` (JSON files, plus an `img/` folder per chat for attached images). They are private to each user and are not removed when a user is deleted. Back up or clean that folder as you see fit.
- `claude-ro` must not read `data/` (`chmod o-rwx data`, done by the script). Images are copied into the chat sandbox only for the message that sends them.
- nginx: copy the `location /api/chat` block from `nginx-monitor.conf` into the live site config. Without it, images larger than 1 MB are rejected (413) and long answers are cut after 30 s (504). Then `sudo nginx -t && sudo systemctl reload nginx`.
- `SCAN_DIR` must point to the folder that holds your projects, otherwise Claude has no folder to search.

## Search scope

- A superadmin's Claude can search all of `SCAN_DIR` plus the folders in `CHAT_EXTRA_DIRS` (for example `/var/log,/home/zae`). Other admins only get the projects they may see.
- What Claude can really read is decided by the OS permissions of `claude-ro`. To let it read system logs such as `/var/log/nginx`, add it to the right group, for example `sudo usermod -aG adm claude-ro`, then restart the monitor. Only add what you are willing to show in the chat.
- `Grep` and `Glob` skip files ignored by `.gitignore`, which includes most Laravel `storage/logs/*.log`. Claude is told to find the log with `Glob` and then pass the exact file path to `Grep` (or use `Read`).

## Commands with approval (optional, superadmin only)

1. Install bubblewrap if it is missing: `sudo apt install bubblewrap`.
2. Set `CHAT_SHELL=1` in the monitor environment (and `CHAT_NODE=/usr/bin/node` if the node that runs the monitor is not executable by `claude-ro`), then `pm2 restart vps-monitor --update-env`.
3. The chat header then says "read-only · commands need approval". When Claude wants to run a command that can change something, a card shows the exact command with **Approve** and **Deny**. No answer within 5 minutes means deny. Clearly read-only commands (such as `ls`, `cat`, `echo`) are run by Claude Code without asking. Every decision is written to the Activity Log as `chat.run`.
4. The whole Claude process runs inside `bwrap` with a read-only filesystem (only a private `/tmp` and the home of `claude-ro` are writable), so an approved command cannot change your files. The network is not blocked: read the command before approving, especially anything with `curl` or `wget`.
5. It switches itself off (the chat stays read-only) if `CHAT_SHELL` is not `1`, the user is not a superadmin, `bwrap` is missing, or the monitor does not run as root.

## Tinker with approval (optional, superadmin only)

Claude cannot run `php artisan tinker` itself (it has no database credentials and its disk is read-only). Instead it gets a `tinker` tool, and the **monitor** runs it for it, after you approve the exact PHP code.

1. In the monitor `.env`: `CHAT_TINKER=1` (optional: `CHAT_TINKER_USER=www-data`, the user the web app runs as, and `CHAT_PHP=/usr/bin/php`). The monitor must run as root. Then `pm2 restart vps-monitor`.
2. The chat header then says "... tinker need approval". When Claude wants to run PHP, a card shows the project and the code with three buttons: **Run (roll back DB changes)**, **Run and keep changes**, **Deny**. No answer within 5 minutes means deny.
3. Rolling back wraps the code in a database transaction that is always rolled back. It only undoes normal INSERT/UPDATE/DELETE on the default connection. It does not undo table changes, cache/Redis, files, mail, queued jobs or API calls, so read the code before approving, especially "Run and keep changes".
4. The code runs with `php artisan tinker --execute=...` inside the project folder as `CHAT_TINKER_USER`, with no shell, a 60 s limit, and the output cut at 20 KB. Only folders in `SCAN_DIR` that contain an `artisan` file are accepted. Each decision is written to the Activity Log as `chat.tinker`.
5. Text in logs or data can try to trick Claude into proposing harmful code. The card is the only safeguard, so always read it.
