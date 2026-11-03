# AI Chat: real search scope and commands with user confirmation

Date: 2026-11-03
Status: approved in conversation. Extends `2026-11-03-ai-chat-design.md` and `2026-11-03-ai-chat-history-images-design.md`.

## Problem 1: Claude cannot search the projects

The chat sandbox was a folder of symlinks. Claude's `Glob` and `Grep` do not follow symlinks (verified with the real CLI: a `**/*.log` glob found nothing through a symlink and found the file through `--add-dir`). On the VPS this made Claude say it found no project or log files.

### Fix
- The per-user sandbox folder stays only as Claude's working directory and holds `_uploads/`. It no longer contains symlinks.
- Claude gets real paths with `--add-dir`, placed last in the argument list:
  - Superadmin: `SCAN_DIR` itself, plus the folders in `CHAT_EXTRA_DIRS` (comma separated, absolute, must exist). Owner's VPS uses `/var/log,/home/zae`.
  - Other admins: only the projects they may see (`isHidden`), each as `SCAN_DIR/<name>`; names must match `^[A-Za-z0-9._-]+$`, not start with `.`, and be directories.
- What `claude-ro` can actually read is still decided by the OS. To read `/var/log/nginx` the owner adds `claude-ro` to the `adm` group. Claude does not run as root.

## Feature 2: commands with confirmation

### Who and when
- Only a superadmin, and only when `CHAT_SHELL=1`, the process runs as root (so Claude runs as `claude-ro`), and `bwrap` exists. Otherwise the chat stays read-only exactly as today.
- Claude Code itself runs clearly read-only commands (for example `echo`, `ls`, `cat`) without asking. Commands that can change something are sent to the user.

### Mechanism (verified with the real CLI)
- Claude is started with `--permission-mode default`, `--permission-prompt-tool mcp__vpsmon__approve`, `--mcp-config <json>` and `--strict-mcp-config`. `Bash` is removed from the deny list; `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch` and the secret-file `Read` rules stay denied.
- `chat-mcp.js` is a dependency-free MCP stdio server with one tool, `approve`. It forwards `{token, tool_name, input}` to the monitor's internal approval server and returns `{"behavior":"allow","updatedInput":...}` or `{"behavior":"deny","message":...}` as JSON text.
- The internal approval server is a separate HTTP server on `127.0.0.1` with an ephemeral port (not reachable through nginx). Each chat run gets a random 32-byte token valid only while the run lasts.
- Only `Bash` can be approved; any other tool is denied without asking.
- The monitor sends SSE `{confirm:{id, tool, command, description}}` to the browser and waits. The browser answers with `POST /api/chat/confirm {id, allow}`. Only the user who owns the run can answer (404 for others). No answer within 5 minutes means deny.
- The 120 s run timeout does not fire while a confirmation is pending. The stream sends an SSE comment every 15 s so nginx does not close it.
- Every decision is written to the Activity Log (`chat.run`, command, approved or denied).

### bwrap
In shell mode the whole `claude` process is started through
`bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --ro-bind <sandbox> <sandbox> --bind <CHAT_HOME> <CHAT_HOME> --unshare-pid --die-with-parent -- claude ...`.
The filesystem is read-only except `/tmp` (private, temporary) and the home of `claude-ro`. An approved command that tries to write fails. Network is not blocked, so the user must read the command before approving.

### UI
A card in the chat: "Claude wants to run a command", the command in a code block, optional description, **Approve** and **Deny**. After clicking it shows the result. The header badge says "read-only · commands need approval" when shell mode is on for the user (`GET /api/chat/models` returns `shell`).

## Config
`CHAT_SHELL=1`, `CHAT_EXTRA_DIRS`, `CHAT_BWRAP` (path override, default `/usr/bin/bwrap`).

## Tests
Argument building for both scopes; extra dirs only for superadmin; hidden projects not added; shell flags only in shell mode; approval allow/deny/timeout and owner-only confirm using a fake claude that talks to the approval server like the MCP tool does; shell not enabled for admin, without `CHAT_SHELL`, without bwrap, or when not root. Real-CLI checks: Glob/Grep through `--add-dir`, MCP approval (done for the mechanism).
