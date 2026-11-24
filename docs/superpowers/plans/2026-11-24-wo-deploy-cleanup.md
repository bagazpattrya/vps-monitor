# WO Deploy, Hapus, Filter/Grup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Dari `/orders`: deploy WO `MERGED` ke VPS + buka website, hapus WO selesai, kelompokkan daftar per project/status.

**Architecture:** `orchestrator.js` dapat dua endpoint admin (`/api/wo/links`, `/api/wo/delete`) dan menyimpan peta link di `data/wo-links.json`. UI (`public/js/orders.js`, `orders.html`) memakai `/api/git/pull` yang sudah ada untuk deploy.

**Tech Stack:** Node tanpa dependency, `node --test`, vanilla JS.

**Spec:** `docs/superpowers/specs/2026-11-24-wo-deploy-cleanup-design.md`

## Global Constraints
- Status boleh dihapus: `MERGED, REJECTED, FAILED, OVER_BUDGET`. Maks 200 id per request.
- `url` link: `http(s)://`, maks 300 char. `repo`: tanpa `..`, tanpa `/` awal, tanpa `\0`, maks 300 char.
- Audit: `wo.link`, `wo.delete`. Semua endpoint baru khusus admin (403 jika bukan).
- Semua nilai di UI di-escape (`escHtml`).

## Review Focus
- Hapus id tidak ada / status aktif / `COMPLETED` -> dilewati dan dilaporkan, tidak error.
- Link `url` `javascript:` ditolak.
- Menghapus link (`repo` dan `url` kosong) menghilangkan entri.
- Hapus massal saat filter aktif hanya menghapus yang tampil.

### Task 1: Backend links + delete

**Files:** Modify `orchestrator.js`; Test `test/orchestrator.test.js`; Modify `docs/orchestrator.md`.

**Interfaces:**
- Produces: `GET /api/wo/links` -> `{links:{[key]:{repo,url}}}`; `POST /api/wo/links {project_key, repo, url}` -> `{links}`; `POST /api/wo/delete {ids}` -> `{deleted:[id], skipped:[{id,reason}]}`; `GET /api/wo` ikut mengembalikan `links`.

- [ ] **Step 1: Tulis test gagal** di `test/orchestrator.test.js` (pakai `boot`, `good`): `links: simpan, hapus, tolak url javascript: dan repo ber-..` ; `delete: hanya status selesai, lainnya skipped` (buat WO PENDING -> skipped `status`; paksa MERGED lewat alur approve+merge-result -> deleted dan hilang dari `GET /api/wo`; id acak -> skipped `tidak ada`); `viewer -> 403` untuk kedua endpoint.
- [ ] **Step 2: Jalankan** `node --test test/orchestrator.test.js` -> FAIL.
- [ ] **Step 3: Implement** di `orchestrator.js`: konstanta `DELETABLE`; `rmFiles(w)` (ekstrak dari `prune`, dipakai ulang); `links` dimuat dari `wo-links.json` (tulis atomik seperti `save`); route baru di `handleAdmin` SEBELUM regex `one`; tambahkan `links` ke respons `GET /api/wo`.
- [ ] **Step 4: Jalankan** `node --test` -> semua PASS.
- [ ] **Step 5: Docs** tambah endpoint ke tabel `docs/orchestrator.md`. Commit `feat(wo): link project dan hapus WO selesai`.

### Task 2: UI deploy, hapus, grup

**Files:** Modify `public/js/orders.js`, `public/orders.html`, `public/css/style.css`.

**Interfaces:** Consumes Task 1 endpoints, `/api/git/projects` (`projects[].relPath,name`), `/api/git/pull {relPath}` -> `{ok, output}`.

- [ ] **Step 1: orders.html** — dropdown `#woGroup` (Tanpa grup/Project/Status), tombol `#woDelSel`, `#woDelDone`, kolom checkbox (`#woCheckAll`) di thead, `colspan` 7.
- [ ] **Step 2: orders.js render** — grup per `project_key`/`status` dengan baris header (nama + jumlah); checkbox per baris hanya untuk status `DELETABLE`; `selected` Set bertahan antar refresh 5 detik; `woGroup` disimpan di `localStorage` (try/catch).
- [ ] **Step 3: hapus** — `#woDelSel` dua klik (pola `armed` seperti Approve) lalu `POST /api/wo/delete`; `#woDelDone` memilih semua baris tampil yang `DELETABLE`.
- [ ] **Step 4: detail MERGED** — tombol Deploy (`POST /api/git/pull`, tampil output di `.wo-pre`), lalu tautan Buka website; tanpa link: form kecil (select repo dari `/api/git/projects`, input URL) -> `POST /api/wo/links`.
- [ ] **Step 5: Verifikasi** `node --check public/js/orders.js`, `node --test`; cek manual di browser jika server lokal jalan. Commit `feat(orders): deploy, hapus, dan grup WO`.
