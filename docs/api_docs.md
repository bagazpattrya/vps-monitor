# API WO Orchestrator untuk work.microspace.id

API untuk mengirim laporan bug dari work.microspace.id menjadi Work Order (WO) yang dikerjakan AI, mengecek statusnya, dan bertanya ke AI chat tentang kode project.

**Base URL:** `https://server.microspace.id`

**Auth:** setiap request wajib membawa header `Authorization: Bearer <EXT_API_TOKEN>`. Token diberikan oleh admin server. Simpan di `.env` work (misalnya `services.orchestrator.token`), jangan di-commit. Token salah atau tidak ada dibalas `401`.

**Format error:** semua error berbentuk `{ "error": "pesan" }`.

| Endpoint | Fungsi |
|---|---|
| `GET /api/wo/projects` | Daftar project yang bisa menerima WO |
| `POST /api/wo` | Kirim bug menjadi WO |
| `GET /api/wo/{wo_id}` | Cek status WO |
| `POST /api/chat` | Tanya AI tentang kode project (read-only) |

---

## 1. Daftar project

`GET /api/wo/projects`

Dipakai untuk mengisi pemetaan project di work ke `project_key` (misalnya kolom `projects.wo_project_key`). Cukup dipanggil saat setting, tidak perlu setiap kirim bug.

Response `200`:

```json
{
  "projects": [
    { "key": "presentracker-hr", "db_sources": ["greenland_hr_db"], "db_default": "greenland_hr_db", "repos": ["dev-hr", "hr-kti"] }
  ]
}
```

- `key`: nilai yang dipakai sebagai `project_key` di endpoint lain.
- `db_sources` / `db_default`: pilihan database untuk field `db_source` (opsional).
- `repos`: folder project di server. Jika kosong, AI chat dengan `project_key` ini belum bisa dipakai (lihat bagian 4).

---

## 2. Kirim bug ke WO

`POST /api/wo`, header `Content-Type: application/json`. Ukuran body maks 30 MB.

| Field | Wajib | Aturan | Isi dari bug |
|---|---|---|---|
| `project_key` | ya | `key` dari endpoint 1 | pemetaan `project_id` |
| `context` | ya | string, maks 4000 karakter | judul + detail + dampak + severity |
| `external_ref` | tidak | string, maks 100 karakter | `"BUG-{id}"` |
| `priority` | tidak | `highest`, `high`, `medium`, `low`, `lowest`. Default `highest` | `critical` → `highest`, `high` → `high`, `medium` → `medium`, `low` → `low` |
| `images` | tidak | maks 4 gambar, masing-masing maks 5 MB, base64 atau data URL, format PNG/JPG/WebP/GIF | file `screenshot` |
| `goals` | tidak | maks 10 string, masing-masing maks 500 karakter | kriteria bug dianggap beres |
| `files_hint` | tidak | maks 20 string, masing-masing maks 200 karakter | file yang dicurigai |
| `verification.target_url` | tidak | string, maks 300 karakter | URL halaman yang bug |
| `db_source` | tidak | salah satu `db_sources` project | kosong = `db_default` |

Contoh request:

```json
{
  "project_key": "presentracker-hr",
  "external_ref": "BUG-512",
  "priority": "high",
  "context": "Judul: Gagal simpan cuti\nDetail: klik Simpan muncul error 500\nDampak: karyawan tidak bisa ajukan cuti\nSeverity: major",
  "goals": ["Pengajuan cuti tersimpan tanpa error"],
  "verification": { "target_url": "https://hr.example.com/leave/create" },
  "images": ["data:image/png;base64,iVBOR..."]
}
```

Response `201`. Simpan `wo.id` di data bug (misalnya kolom `bugs.orch_wo_id`) untuk cek status.

```json
{
  "wo": {
    "id": "WO-bugreport-a1b2c3",
    "status": "PENDING",
    "priority": "high",
    "project_key": "presentracker-hr",
    "external_ref": "BUG-512",
    "created_at": "2026-11-26T09:00:00.000Z"
  }
}
```

Error:

| Kode | Arti |
|---|---|
| `400` | Input tidak valid, atau `project_key` tidak dikenal. Pesan error berisi daftar pilihan yang valid. |
| `401` | Token salah atau tidak ada. |
| `429` | Budget harian habis. Coba lagi besok. |

Contoh Laravel:

```php
$res = Http::withToken(config('services.orchestrator.token'))->timeout(30)
    ->post(config('services.orchestrator.url').'/api/wo', [
        'project_key'  => $bug->project->wo_project_key,
        'external_ref' => 'BUG-'.$bug->id,
        'priority'     => ['critical' => 'highest', 'high' => 'high', 'medium' => 'medium', 'low' => 'low'][$bug->priority] ?? 'medium',
        'context'      => mb_substr("Judul: {$bug->title}\nDetail: {$bug->detail}\nDampak: {$bug->reported_impact}\nSeverity: {$bug->severity}", 0, 4000),
        'images'       => $bug->screenshot && Storage::exists($bug->screenshot)
            ? [base64_encode(Storage::get($bug->screenshot))] : [],
    ]);

if ($res->successful()) {
    $bug->update(['orch_wo_id' => $res->json('wo.id')]);
} else {
    // tampilkan $res->json('error') ke user
}
```

---

## 3. Cek status WO

`GET /api/wo/{wo_id}`

Response `200`: `{ "wo": { ... } }`. Field yang penting:

| Field | Isi |
|---|---|
| `status` | lihat tabel di bawah |
| `result` | hasil kerja AI: ringkasan, `branch`, `patch` |
| `cost_usd` | biaya AI untuk WO ini |
| `completed_at` | waktu AI selesai |
| `merge` | hasil merge setelah disetujui |
| `review_note` | catatan reviewer saat approve/reject |

| `status` | Arti | Saran untuk bug |
|---|---|---|
| `PENDING`, `IN_PROGRESS` | Antre atau sedang dikerjakan AI | `in_progress` |
| `COMPLETED`, `NEEDS_REVIEW` | Perbaikan selesai, menunggu review admin | `in_progress` |
| `APPROVED`, `MERGING` | Disetujui, sedang di-merge | `in_progress` |
| `MERGED` | Perbaikan sudah masuk | `resolved` |
| `REJECTED`, `FAILED`, `OVER_BUDGET`, `MERGE_FAILED` | Gagal atau ditolak | tangani manual |

Belum ada webhook. Cek status dengan polling (misalnya cron tiap 5 menit untuk bug yang statusnya belum final) atau saat halaman bug dibuka.

`404` = WO tidak ditemukan (sudah dihapus admin).

---

## 4. AI chat (tanya saja, tidak memperbaiki bug)

`POST /api/chat`, header `Content-Type: application/json`.

| Field | Wajib | Aturan |
|---|---|---|
| `message` | ya | pertanyaan |
| `project_key` | tidak (disarankan) | batasi AI ke kode project ini |
| `chatId` | tidak | `chatId` dari jawaban sebelumnya, untuk melanjutkan percakapan |
| `images` | tidak | sama seperti `images` di endpoint 2 |

```json
{ "project_key": "presentracker-hr", "message": "Kenapa simpan cuti bisa error 500?" }
```

- AI hanya bisa membaca kode project, tidak bisa mengubah file atau menjalankan perintah.
- Response berupa stream SSE (`Content-Type: text/event-stream`). Setiap baris berbentuk `data: {...}`:

| Event | Arti |
|---|---|
| `{"chatId":"..."}` | ID percakapan. Simpan untuk melanjutkan. |
| `{"text":"..."}` | Potongan jawaban. Gabungkan berurutan. |
| `{"tool":"..."}` | Info AI sedang membaca file. Boleh diabaikan. |
| `{"error":"..."}` | Gagal. Datang sebelum `done`. |
| `{"done":true}` | Selesai. |

- Jawaban bisa makan waktu sampai 5 menit. Set timeout HTTP minimal 300 detik.
- Limit dihitung untuk semua pengguna work.microspace.id bersama (satu token): hanya 1 chat boleh berjalan sekaligus, dan maks 20 pertanyaan per jam. Selebihnya dibalas `429`. Tampilkan pesan "AI sedang sibuk, coba lagi" ke user, atau antrekan di sisi work.

Error:

| Kode | Arti |
|---|---|
| `400` | `message` kosong atau terlalu panjang, atau `project_key` belum punya folder di server (minta admin menautkannya). |
| `401` | Token salah atau tidak ada. |
| `429` | `A chat is already running` (chat lain masih berjalan) atau `Hourly chat limit reached`. Coba lagi nanti. |

Contoh Laravel (tanpa streaming, jawaban digabung di akhir):

```php
$res = Http::withToken(config('services.orchestrator.token'))->timeout(300)
    ->post(config('services.orchestrator.url').'/api/chat', [
        'project_key' => $project->wo_project_key,
        'message'     => $question,
        'chatId'      => $chatId, // null untuk percakapan baru
    ]);

$events = collect(explode("\n", $res->body()))
    ->filter(fn ($l) => str_starts_with($l, 'data: '))
    ->map(fn ($l) => json_decode(substr($l, 6), true));

$chatId = $events->firstWhere('chatId')['chatId'] ?? $chatId;
$error  = $events->firstWhere('error')['error'] ?? null;
$answer = $events->pluck('text')->filter()->implode('');
```

---

## 5. Setup

### 5.1 Server (VPS monitor), dikerjakan admin server

1. Deploy kode API ke `/var/www/vps-monitor` (`git pull`).
2. Tambahkan ke `.env` monitor (file milik root, `chmod 600`):
   ```
   EXT_API_TOKEN=<hasil: openssl rand -hex 32>
   # opsional:
   EXT_API_USER=bugreport              # nama pembuat WO di log, default bugreport
   EXT_API_HIDDEN=keyword1,keyword2    # project yang tidak boleh dibaca AI chat
   ```
3. Restart sebagai root: `pm2 restart vps-monitor --update-env`.
4. Di halaman `/orders`, tautkan folder server untuk setiap project yang akan dipakai AI chat. Project tanpa folder tertaut (`repos` kosong di `GET /api/wo/projects`) dibalas `400` oleh `POST /api/chat` dengan `project_key`.
5. Kirim `EXT_API_TOKEN` ke developer work.microspace.id lewat jalur aman (bukan lewat chat grup atau git).

### 5.2 work.microspace.id, dikerjakan developer work

1. `.env`:
   ```
   ORCHESTRATOR_URL=https://server.microspace.id
   ORCHESTRATOR_TOKEN=<EXT_API_TOKEN dari admin server>
   ```
2. `config/services.php`:
   ```php
   'orchestrator' => [
       'url'   => env('ORCHESTRATOR_URL'),
       'token' => env('ORCHESTRATOR_TOKEN'),
   ],
   ```
   Lalu `php artisan config:cache`.
3. Migration:
   ```php
   Schema::table('projects', fn (Blueprint $t) => $t->string('wo_project_key', 64)->nullable());
   Schema::table('bugs', fn (Blueprint $t) => $t->string('orch_wo_id', 64)->nullable()->index());
   ```
   Isi `projects.wo_project_key` dari `key` di `GET /api/wo/projects` (misalnya dropdown di form edit project). Project tanpa `wo_project_key` tidak bisa dikirim ke WO: sembunyikan atau nonaktifkan tombolnya.
4. Tombol "Kirim ke WO" memanggil `POST /api/wo` (bagian 2) dan menyimpan `wo.id` ke `bugs.orch_wo_id`. Cegah kirim ganda: jika `orch_wo_id` sudah terisi dan WO belum final, jangan kirim lagi.
5. Command terjadwal (misalnya tiap 5 menit di `routes/console.php` / `Kernel`) yang memanggil `GET /api/wo/{orch_wo_id}` untuk bug yang WO-nya belum final, lalu memperbarui status bug (tabel di bagian 3). Pastikan cron `schedule:run` aktif.
6. Timeout AI chat: jawaban bisa sampai 300 detik. Jika chat dipanggil langsung di request web, naikkan `fastcgi_read_timeout 310s` di vhost nginx dan `max_execution_time` ≥ 310 di PHP-FPM. Alternatif yang lebih aman: jalankan chat di queue job lalu tampilkan hasilnya saat selesai.

### Keamanan

- Token ini bisa membuat WO (memakai budget AI harian) dan membaca kode semua project yang tidak disembunyikan lewat AI chat. Perlakukan seperti password database.
- Panggil API hanya dari backend Laravel. Jangan taruh token di JavaScript, HTML, atau respons ke browser.
- Jangan commit `.env`. Jika token bocor, minta admin server mengganti `EXT_API_TOKEN`; token lama langsung tidak berlaku setelah restart.
- Batasi siapa yang boleh menekan tombol "Kirim ke WO" dan memakai AI chat di work (misalnya hanya role developer/admin).
