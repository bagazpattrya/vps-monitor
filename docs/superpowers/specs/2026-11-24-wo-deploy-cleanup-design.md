# WO Orchestrator: Deploy, Hapus, Filter/Grup (design singkat)

## Tujuan
Setelah WO `MERGED`, admin bisa deploy ke VPS dan buka websitenya dari `/orders`, tanpa pindah ke dashboard Deploy. WO selesai bisa dirapikan.
Non-goal: drag-urut manual, perubahan worker di laptop.

## Approaches
- **A (dipilih user):** peta `project_key` -> `{repo, url}` disimpan di server (`data/wo-links.json`), diisi lewat UI. Tanpa ubah worker.
- B: worker kirim repo/URL lewat `POST /api/wo/projects`. Ditolak: worker dan server harus diubah bersamaan, laptop tidak tahu path VPS.

## Desain
1. **Link project.** `orchestrator.js`: `GET /api/wo/links` (peta + tidak ada validasi repo di server selain format), `POST /api/wo/links` body `{project_key, repo, url}`. `project_key` harus ada di registry/WO; `repo` = relPath (aturan sama dengan `/api/git/pull`, tanpa `..`, tanpa `/` awal); `url` harus `http(s)://`, maks 300 char. `repo`/`url` kosong menghapus link. Audit `wo.link`. Dikirim juga di `GET /api/wo` sebagai `links`.
2. **Deploy.** Detail WO berstatus `MERGED`: tombol **Deploy** memanggil `POST /api/git/pull {relPath: links[project].repo}` (endpoint yang sudah ada, sudah diaudit `git.pull`), menampilkan output, lalu tombol **Buka website** (`target=_blank rel=noopener`). Jika link belum ada: tombol "Atur link" membuka form kecil (dropdown repo dari `/api/git/projects`, input URL).
3. **Hapus.** `POST /api/wo/delete` body `{ids:[...]}` (maks 200). Hanya status selesai: `MERGED, REJECTED, FAILED, OVER_BUDGET, MERGE_FAILED, COMPLETED, NEEDS_REVIEW`... kecuali yang masih menunggu review (`COMPLETED`, `NEEDS_REVIEW`) tidak boleh dihapus agar tidak hilang sebelum diputuskan. Jadi boleh: `MERGED, REJECTED, FAILED, OVER_BUDGET`. Id tidak boleh dihapus dilewati dan dilaporkan. Bersihkan screenshot dan lampiran (pakai logika `prune`). Audit `wo.delete`.
4. **UI list.** Checkbox per baris + "pilih semua yang tampil", tombol "Hapus terpilih" (dua klik konfirmasi), pintasan "Hapus semua yang selesai" (sesuai filter aktif). Pengelompokan: dropdown "Kelompokkan: tanpa / project / status" yang merender header grup (nama + jumlah) di tabel; filter project/status/kompleksitas yang ada tetap. Pilihan filter dan grup disimpan di `localStorage` (opsional, try/catch).

## Dibiarkan ke builder
Gaya CSS header grup; wording pesan; test unit di `test/orchestrator.test.js` untuk delete (status ditolak, bersih file) dan links (validasi).
