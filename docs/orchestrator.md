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
| Admin | `POST /api/wo`, `GET /api/wo`, `GET /api/wo/:id`, `GET /api/wo/shot/:file` | session login admin/superadmin |
| Worker | `GET /api/wo/next?wait=25`, `POST /api/wo/:id/heartbeat`, `POST /api/wo/:id/complete` | `Authorization: Bearer ORCH_WORKER_TOKEN` |

`POST /api/wo` body: `{ project_key, context, goals[], files_hint?[], limits?{max_budget_usd<=1, timeout_sec<=1800, model}, verification?{target_url, viewport} }`.
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
