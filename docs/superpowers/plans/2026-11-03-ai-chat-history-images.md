# AI Chat history and images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Saved per-user conversations and image attachments in the AI chat.

**Architecture:** New `chats.js` (file store, image validation, owner-only HTTP handlers) used by `chat.js` (streaming) and `server.js` (routes). Front-end `chat.html`/`chat.js` rewritten as list plus conversation.

**Tech Stack:** Node >=18, no dependencies, `node:test`, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-11-03-ai-chat-history-images-design.md`

## Global Constraints

- No new dependencies. Conversation id = 24 lowercase hex chars. Image names `^[a-f0-9]{16}\.(png|jpg|webp|gif)$`.
- Image limits: 4 per message, 5 MB each; type from magic bytes only.
- Owner-only access; superadmin gets no extra access. Unknown or foreign id gives 404.
- 200 chats per user cap. Text rendered with `textContent` only.
- Data dir from env `CHAT_DATA_DIR`, default `<repo>/data/chats`, read at call time (tests override it).

## Review Focus

- `chatId` like `../../users` or 23/25 chars: 404 and no file touched.
- A fake `.png` (text bytes), a 5 MB + 1 image, 5 images, non-string image: 400, nothing saved.
- User B requests user A's chat or image: 404.
- Chat deleted while a reply streams: final append does not recreate the file.
- Stored `claudeSessionId` that is not a UUID is ignored, not passed to argv.
- Claude fails or times out: user message and an `error: true` assistant message remain in the file.

---

### Task 1: `chats.js` store and image helpers
**Files:** Create `chats.js`, `test/chats.test.js`; modify `.gitignore` (add `data/chats/`).
**Interfaces (Produces):**
- `isChatId(id) -> boolean`; `userDir(user) -> string`
- `createChat(user, { message, model }) -> chat` (title from message, enforces 200 cap)
- `getChat(user, id) -> chat | null`; `listChats(user) -> [{id,title,model,updatedAt}]` newest first
- `updateChat(user, id, fn(chat)) -> chat | null` (null if missing; atomic write; bumps `updatedAt`)
- `renameChat(user, id, title) -> chat | null`; `deleteChat(user, id) -> boolean` (removes json and `<id>/` folder)
- `sniffImage(buf) -> { ext, type } | null`; `decodeImages(list) -> [{ buf, ext }]` (throws `Error` with a user-facing message)
- `saveImages(user, id, imgs) -> string[]` (names)
- [ ] Write failing tests for each Review Focus line that belongs here, plus create/get/list order/rename/delete/cap(use a small cap via exported `MAX_CHATS` override param) and `sniffImage` for the four formats.
- [ ] Run `npm test`, expect FAIL (`Cannot find module '../chats.js'`).
- [ ] Implement.
- [ ] Run `npm test`, expect PASS. Commit.

### Task 2: Persist and attach in `handleChat`
**Files:** Modify `chat.js`, `test/chat.test.js`.
**Interfaces:** Consumes Task 1. `handleChat` body gains `chatId?`, `images?`; client `sessionId` no longer accepted. SSE first event `{chatId}`. `buildSandbox` skips `_uploads`; new `addUploads(sandboxDir, files: {name, buf}[])`.
- [ ] Update tests: replace the bad-sessionId test with bad-chatId (404) and bad-image (400) tests; add tests for persistence (user + assistant messages saved), error persisted with `error:true`, partial text on disconnect, session id stored and reused as `--resume` only when UUID, image copied to `_uploads/` and named in stdin, delete-while-running does not recreate file.
- [ ] Run, expect FAIL. Implement. Run, expect PASS. Commit.

### Task 3: Chats HTTP API and wiring
**Files:** Modify `chats.js` (add `handleChatsApi`), `server.js`, `nginx-monitor.conf`, `server.microspace.id.conf`; extend `test/chats.test.js`.
**Interfaces:** `handleChatsApi({ req, res, session, pathname, body }) -> boolean` handles `GET/PATCH/DELETE /api/chats...` and image GET; returns false if not its path.
- [ ] Tests with fake req/res: list/get/patch/delete as owner; 404 for other user and for bad ids; image served with `nosniff`; viewer gets 403.
- [ ] Implement. In `server.js`: route `p.startsWith('/api/chats')` (read JSON body for PATCH), and raise `/api/chat` body limit to `28 * 1024 * 1024`.
- [ ] Add `location /api/chat { client_max_body_size 30M; proxy_read_timeout 150s; proxy_buffering off; ...same proxy headers... }` to both nginx confs.
- [ ] Run suite, smoke test on a throwaway copy of the app (401/403/404, list after chat). Commit.

### Task 4: Front-end
**Files:** Modify `public/chat.html`, `public/js/chat.js`, `public/css/style.css`.
- [ ] Two-column layout, chat list with rename/delete, load last chat, attach/paste/drag with thumbnails and remove, images in messages, model per chat, narrow-screen panel.
- [ ] Verify in browser against the throwaway app with the fake binary: refresh keeps history, pasted image shows and reaches the fake binary, delete works. Commit.

### Task 5: Docs and setup script
**Files:** Create `scripts/setup-claude-ro.sh`; modify `docs/ai-chat-setup.md`.
- [ ] Script (run by the owner with sudo; prints what it does, makes no change when run with `--dry-run`): create `claude-ro`, copy the claude binary to `/usr/local/bin`, set permissions so `claude-ro` cannot read `data/`. Document nginx change and `SCAN_DIR`. Commit.

---

## Self-review

Spec coverage: storage, API, flow, front-end, deployment notes each map to Tasks 1-5. Names consistent across tasks (`createChat`, `getChat`, `updateChat`, `deleteChat`, `saveImages`, `handleChatsApi`).
