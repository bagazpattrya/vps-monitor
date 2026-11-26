# Orchestrator (antrean Work Order)

Server hanya menyimpan antrean dan hasil. Agent (`claude -p`) jalan di laptop lewat `worker.js`.
Data: `data/work-orders.json` (500 WO terakhir), screenshot di `data/wo-shots/` (dihapus setelah 30 hari).

## Pasang
1. `.env`: `ORCH_WORKER_TOKEN=$(openssl rand -hex 32)`. Tanpa ini endpoint worker mati (503).
2. Terapkan blok `location /api/wo/` dari `server.microspace.id.conf` ke vhost, lalu `nginx -t && systemctl reload nginx`.
3. `pm2 restart vps-monitor --update-env` (butuh root).

## Endpoint
| Siapa | Endpoint | Auth |
|---|---|---|
| Admin | `POST /api/wo`, `GET /api/wo`, `GET/POST /api/wo/links`, `POST /api/wo/delete`, `GET /api/wo/:id`, `GET /api/wo/shot/:file`, `POST /api/wo/:id/approve`, `POST /api/wo/:id/reject`, `POST /api/wo/:id/revise`, `POST /api/wo/:id/priority` | session login admin/superadmin |
| Worker | `GET /api/wo/next?wait=25`, `POST /api/wo/:id/heartbeat`, `POST /api/wo/:id/complete`, `POST /api/wo/:id/merge-result` | `Authorization: Bearer ORCH_WORKER_TOKEN` |

`POST /api/wo` body: `{ project_key, context, priority?, goals?[], files_hint?[], limits?{max_budget_usd<=3, timeout_sec<=1800, model}, verification?{target_url, viewport} }`.
`complete` body: `{ status: COMPLETED|FAILED|OVER_BUDGET|NEEDS_REVIEW, result: {...}, screenshot_b64? }`.
`result.complexity` (`simple`|`complex`, opsional) + `result.complexity_reason` (maks 300 char): flag dari agent worker. UI `/orders` punya filter kompleksitas supaya audit mulai dari yang complex. Nilai lain dibuang.

Membuat WO dari CLI (belum ada UI): login dulu untuk dapat cookie.
```
curl -c jar -H 'Content-Type: application/json' -d '{"username":"...","password":"..."}' https://server.microspace.id/api/login
curl -b jar -H 'Content-Type: application/json' -d '{"project_key":"lapila","context":"...","goals":["..."]}' https://server.microspace.id/api/wo
```

## Perilaku
- **Prioritas**: `priority` = `highest` | `high` | `medium` | `low` | `lowest`, default `highest` (WO lama tanpa field dianggap `medium`). Worker mengambil `PENDING` (dan job merge `APPROVED`) dengan prioritas tertinggi dulu; prioritas sama = FIFO. Ubah lewat `POST /api/wo/:id/priority {priority}` (atau dropdown di detail WO) selama status masih `PENDING`/`APPROVED`; selain itu 409. Audit: `wo.priority`.
- Lease 120 detik; worker kirim heartbeat tiap 30 detik. Lease habis: WO kembali `PENDING`, setelah 2 kali `FAILED`.
- WO baru ditolak (429) jika total `cost_usd` hari ini >= `ORCH_DAILY_BUDGET_USD`.
- Budget per WO di-clamp maksimum $1.

## Review dan merge (Approve)
`complete` ikut membawa `result.patch` (maks 200 KB), `result.head_sha`, dan `result.branch` (`wo/...`). UI menampilkan patch berwarna.

Alur: `COMPLETED` / `NEEDS_REVIEW` -> admin klik **Approve**, lalu memilih pull ke **Dev saja** atau **Semua** di popup -> `APPROVED` -> worker mengambilnya (`GET /api/wo/next` mengembalikan `kind: "merge"`) -> `MERGING` -> `MERGED` atau `MERGE_FAILED`. `Reject` membuat `REJECTED`. `MERGE_FAILED` boleh di-approve ulang.

Setelah `MERGED`, VPS otomatis `git pull` folder yang ter-link ke project (`/api/wo/links`). Pilihan saat approve (`POST /api/wo/:id/approve` body `{ "pull": "dev" | "all" }`, default `dev`): `dev` hanya folder ber-flag `isDev`, `all` termasuk produksi. Folder dengan perubahan lokal dilewati. Worker tidak berubah: pull dikerjakan VPS. Progres (menunggu worker, merging, git pull, hasil) tampil di kolom aksi daftar WO; output lengkap di detail WO (`autopull`).

- **VPS tidak memilih target.** Branch tujuan hanya dari `projects.json` di laptop (`"target": "development"`). Project tanpa `target` tidak bisa di-merge: hasilnya `MERGE_FAILED` dengan pesan jelas.
- Worker hanya merge jika branch WO masih di `head_sha` yang direview, working tree bersih, dan `target` lokal bisa fast-forward ke `origin/<target>`.
- Konflik: merge dibatalkan. Push ditolak: target lokal dikembalikan ke keadaan semula.
- Setiap approve/reject/merge masuk Activity Log (`wo.approve`, `wo.reject`, `wo.merge`).
- **Reject membersihkan branch.** WO `REJECTED` yang punya `result.branch` mendapat `cleanup: {state}` (`PENDING` -> `RUNNING` -> `DONE|SKIPPED|FAILED`). Worker yang memanggil `GET /api/wo/next?cleanup=1` menerima `kind: "cleanup"` (prioritas paling rendah) lalu menjalankan `git branch -D` dan melapor ke `POST /api/wo/:id/cleanup-result {status, detail}`. Worker tanpa `cleanup=1` tidak pernah menerimanya, jadi worker lama aman. Worker hanya menghapus `wo/*` yang masih di `head_sha` yang direview (ada commit tambahan = `SKIPPED`). WO yang menunggu cleanup tidak bisa dihapus lewat `POST /api/wo/delete`.
- WO lama tanpa `head_sha` tidak bisa di-approve (merge manual di laptop).
- **Revisi di branch yang sama.** `POST /api/wo/:id/revise {note}` (note wajib, maks 2000) untuk status `COMPLETED`, `NEEDS_REVIEW`, `MERGE_FAILED`, `REJECTED`, `FAILED`, `OVER_BUDGET` yang punya branch + `head_sha` (atau revisi sebelumnya). WO kembali `PENDING` dengan `revision: {n, branch, head_sha, base_sha}` dan catatan masuk `revisions[]` (maks 20). Cleanup branch yang masih `PENDING` dibatalkan; jika cleanup `RUNNING`/`DONE` = 409 (branch sudah dihapus, buat WO baru). Worker melihat `wo.revision`: `git switch` ke branch itu (hanya jika masih di `head_sha` yang direview), menjalankan agent dengan semua catatan revisi di prompt, commit baru di atasnya, lalu `complete` seperti biasa. Patch yang dikirim tetap seluruh WO (`base_sha..HEAD`). `cost_usd` dijumlahkan. Hasilnya direview ulang: Approve -> merge, atau revisi lagi. Audit: `wo.revise`. Worker lama tidak mengenal `revision` (akan gagal karena branch sudah ada): update worker dulu.
- Update worker dan server bersamaan. Worker lama yang tidak mengenal `kind: "merge"` akan salah menjalankan agent untuk job merge.

## Sync DB untuk worker

`GET /api/wo/db-dump?db=NAMA` (Bearer worker) men-stream `mysqldump | gzip`. Hanya DB yang tercantum di `ORCH_DUMP_DBS` (env server, pisah koma); kosong = mati. Dipakai `db_sync` di `projects.json` laptop (lihat README agent-worker). Dump production berisi data pribadi: batasi allowlist seminimal mungkin.

`GET /api/wo/db-list` (Bearer worker) mengembalikan `{ dbs: [...] }`, isi `ORCH_DUMP_DBS` apa adanya — dipakai client (mis. db-downloader) untuk mengisi dropdown pilihan DB tanpa perlu tahu isi allowlist lebih dulu.

## Sumber DB per WO
Worker mendaftarkan `db_sources` + `db_default` per project (dari `db_sync.sources` di `projects.json` laptop) lewat `POST /api/wo/projects`. `POST /api/wo` menerima `db_source` (harus ada di daftar project itu, jika kosong dipakai default); nilainya ikut di payload WO ke worker. Setiap DB harus ada di `ORCH_DUMP_DBS` (isi di `.env`, bukan `ecosystem.config.js` karena nilai ecosystem menimpa `.env`).

## Link project, Deploy, Hapus
- `POST /api/wo/links {project_key, repos:[{repo, url}]}` (maks 50) menyimpan folder VPS (relPath, sama seperti `/api/git/pull`) + URL website per folder di `data/wo-links.json`; satu repo GitHub yang di-clone ke banyak folder cukup didaftarkan semuanya. `repos` kosong menghapus link. Di detail WO `MERGED`, admin mencentang folder mana yang di-deploy (default kosong), lalu **Deploy terpilih** menjalankan `/api/git/pull` berurutan per folder; satu gagal tidak menghentikan yang lain, folder dengan perubahan lokal diberi peringatan dan konfirmasi.
- `POST /api/wo/delete {ids}` (maks 200) hanya menghapus status `MERGED`, `REJECTED`, `FAILED`, `OVER_BUDGET`; sisanya dilaporkan di `skipped`. Screenshot dan lampiran ikut dihapus. Audit: `wo.delete`, `wo.link`.
