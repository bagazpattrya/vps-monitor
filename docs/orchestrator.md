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
| Admin | `POST /api/wo`, `GET /api/wo`, `GET /api/wo/:id`, `GET /api/wo/shot/:file`, `POST /api/wo/:id/approve`, `POST /api/wo/:id/reject` | session login admin/superadmin |
| Worker | `GET /api/wo/next?wait=25`, `POST /api/wo/:id/heartbeat`, `POST /api/wo/:id/complete`, `POST /api/wo/:id/merge-result` | `Authorization: Bearer ORCH_WORKER_TOKEN` |

`POST /api/wo` body: `{ project_key, context, goals?[], files_hint?[], limits?{max_budget_usd<=1, timeout_sec<=1800, model}, verification?{target_url, viewport} }`.
`complete` body: `{ status: COMPLETED|FAILED|OVER_BUDGET|NEEDS_REVIEW, result: {...}, screenshot_b64? }`.

Membuat WO dari CLI (belum ada UI): login dulu untuk dapat cookie.
```
curl -c jar -H 'Content-Type: application/json' -d '{"username":"...","password":"..."}' https://server.microspace.id/api/login
curl -b jar -H 'Content-Type: application/json' -d '{"project_key":"lapila","context":"...","goals":["..."]}' https://server.microspace.id/api/wo
```

## Perilaku
- Lease 120 detik; worker kirim heartbeat tiap 30 detik. Lease habis: WO kembali `PENDING`, setelah 2 kali `FAILED`.
- WO baru ditolak (429) jika total `cost_usd` hari ini >= `ORCH_DAILY_BUDGET_USD`.
- Budget per WO di-clamp maksimum $1.

## Review dan merge (Approve)
`complete` ikut membawa `result.patch` (maks 200 KB), `result.head_sha`, dan `result.branch` (`wo/...`). UI menampilkan patch berwarna.

Alur: `COMPLETED` / `NEEDS_REVIEW` -> admin klik **Approve & merge** (dua klik) -> `APPROVED` -> worker mengambilnya (`GET /api/wo/next` mengembalikan `kind: "merge"`) -> `MERGING` -> `MERGED` atau `MERGE_FAILED`. `Reject` membuat `REJECTED`. `MERGE_FAILED` boleh di-approve ulang.

- **VPS tidak memilih target.** Branch tujuan hanya dari `projects.json` di laptop (`"target": "development"`). Project tanpa `target` tidak bisa di-merge: hasilnya `MERGE_FAILED` dengan pesan jelas.
- Worker hanya merge jika branch WO masih di `head_sha` yang direview, working tree bersih, dan `target` lokal bisa fast-forward ke `origin/<target>`.
- Konflik: merge dibatalkan. Push ditolak: target lokal dikembalikan ke keadaan semula.
- Setiap approve/reject/merge masuk Activity Log (`wo.approve`, `wo.reject`, `wo.merge`).
- WO lama tanpa `head_sha` tidak bisa di-approve (merge manual di laptop).
- Update worker dan server bersamaan. Worker lama yang tidak mengenal `kind: "merge"` akan salah menjalankan agent untuk job merge.

## Sync DB untuk worker

`GET /api/wo/db-dump?db=NAMA` (Bearer worker) men-stream `mysqldump | gzip`. Hanya DB yang tercantum di `ORCH_DUMP_DBS` (env server, pisah koma); kosong = mati. Dipakai `db_sync` di `projects.json` laptop (lihat README agent-worker). Dump production berisi data pribadi: batasi allowlist seminimal mungkin.

## Sumber DB per WO
Worker mendaftarkan `db_sources` + `db_default` per project (dari `db_sync.sources` di `projects.json` laptop) lewat `POST /api/wo/projects`. `POST /api/wo` menerima `db_source` (harus ada di daftar project itu, jika kosong dipakai default); nilainya ikut di payload WO ke worker. Setiap DB harus ada di `ORCH_DUMP_DBS` (isi di `.env`, bukan `ecosystem.config.js` karena nilai ecosystem menimpa `.env`).
