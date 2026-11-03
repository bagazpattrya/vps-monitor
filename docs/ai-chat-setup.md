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

4. **Set the monitor environment** (see `env.example`): `CLAUDE_BIN`, `CHAT_USER=claude-ro`, `CHAT_HOME=/home/claude-ro`, `CLAUDE_CODE_OAUTH_TOKEN`. Optional: `CHAT_MODELS=haiku,sonnet` limits the model dropdown (Opus uses the shared subscription limit much faster). Restart: `pm2 restart vps-monitor --update-env`.

5. **Lock down permissions.** `claude-ro` must be able to read the projects admins may see, and nothing else:
   - Project files readable (`o+r`), and not writable by `claude-ro`.
   - Hidden projects, `/root`, and the monitor's `data/` directory not readable by `claude-ro`. Because hidden projects are decided per user by keywords, any project that must stay hidden from some admins cannot be readable by `claude-ro` by path guessing alone. The sandbox only links visible projects, so this step is the second barrier.
   Check: `sudo -u claude-ro touch /var/www/<project>/x` fails; `sudo -u claude-ro cat /root/.bashrc` fails; `sudo -u claude-ro ls /path/to/vps-monitor/data` fails.

6. **End-to-end check.** In the chat page ask "what files are in project X?" and expect an answer. Ask it to edit a file and expect a refusal with the file unchanged. As an admin with `hiddenKeywords`, ask about a hidden project and expect that it is not found.

If a check in step 5 or 6 fails, do not enable the chat for users until it is fixed.

## Saved chats and images

- Conversations are stored per user in `data/chats/<user>/` (JSON files, plus an `img/` folder per chat for attached images). They are private to each user and are not removed when a user is deleted. Back up or clean that folder as you see fit.
- `claude-ro` must not read `data/` (`chmod o-rwx data`, done by the script). Images are copied into the chat sandbox only for the message that sends them.
- nginx: copy the `location /api/chat` block from `nginx-monitor.conf` into the live site config. Without it, images larger than 1 MB are rejected (413) and long answers are cut after 30 s (504). Then `sudo nginx -t && sudo systemctl reload nginx`.
- `SCAN_DIR` must point to the folder that holds your projects, otherwise the sandbox is empty and Claude finds no files.
