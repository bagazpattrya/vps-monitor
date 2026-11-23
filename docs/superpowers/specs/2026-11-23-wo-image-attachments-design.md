# Lampiran gambar di Work Order (design singkat)

## Tujuan
Admin yang membuat WO di `/orders` bisa melampirkan gambar (screenshot bug, mockup) lewat tombol attach, paste (Ctrl+V), atau drop, seperti di chat bot. Agent di laptop bisa melihat gambar itu sebagai konteks tambahan.

## Bukan tujuan
- Bukan galeri atau editor gambar. Tidak ada anotasi, kompres, atau resize.
- Tidak mengubah arah screenshot verifikasi (worker ke server) yang sudah ada.
- Lampiran tidak bisa ditambah setelah WO dibuat.

## Anti-tujuan
- Gambar ikut ter-commit ke repo target.
- File selain gambar masuk, atau VPS menyajikan gambar ke pihak tanpa login.

## Pendekatan yang dipertimbangkan
- **A. Gambar base64 di JSON `POST /api/wo` (dipilih).** Pola sama dengan chat. Satu request, WO selalu lengkap.
- B. Buat WO lalu upload multipart per gambar. Ditolak: WO bisa diambil worker sebelum gambar selesai, ada status baru.
- C. Gambar di payload `/api/wo/next`. Ditolak: response long-poll membengkak dan terkirim ulang tiap retry lease.

## Desain
**Server (`vps-monitor`)**
- `orchestrator.js`: `POST /api/wo` menerima `images?: string[]` (data URL). Divalidasi dengan `chats.decodeImages` (maks 4 gambar, 5 MB, PNG/JPEG/WebP/GIF, dicek dari isi file). Disimpan ke `data/wo-images/<wo-id>/<16 hex>.<ext>` dengan mode 0600. Nama file disimpan di `payload.images`.
- Batas body route ini naik dari 64 KB ke 30 MB (server) dan nginx `/api/wo/` dari 4 MB ke 30 MB. Batas itu hanya untuk `POST /api/wo`, route lain tetap kecil.
- Endpoint unduh: admin `GET /api/wo/:id/img/:name` (session), worker `GET /api/wo/:id/img/:name` (Bearer). Nama divalidasi regex, `X-Content-Type-Options: nosniff`.
- Gambar dihapus bersama WO yang dipangkas dan setelah 30 hari, sama seperti `wo-shots`.
- `orders.html`: tombol attach, paste, drop, dan thumbnail, memakai ulang pola `public/js/chat.js`. Detail WO menampilkan lampirannya.

**Worker (`agent-worker`)**
- Sebelum menjalankan agent, unduh `payload.images` ke folder sementara di luar repo (`os.tmpdir()/wo-<id>-*`), dengan Bearer token.
- `buildPrompt` menambahkan "Attached images (read them with the Read tool):" plus path absolutnya. Folder itu diberikan ke `claude -p` lewat `--add-dir`.
- Folder sementara dihapus di `finally`. Gagal mengunduh = WO gagal dengan pesan jelas, agent tidak jalan tanpa konteks yang diminta.

## Diserahkan ke pembangun
- Pastikan `claude -p` memang bisa Read file di folder `--add-dir` tanpa prompt izin.
- Susunan UI persisnya mengikuti form yang sudah ada.
- Test: validasi gambar di orchestrator, `buildPrompt` dengan gambar.

## Risiko
Server dan worker harus di-update bersamaan. Worker lama mengabaikan `payload.images` tanpa error, jadi agent jalan tanpa gambar.
