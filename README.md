# APBD-Lakehouse (SuraLake)

Platform **Data Lakehouse APBD Kota Surabaya** berbasis **Next.js (App Router)** + **Apache Iceberg** (Medallion Architecture: `Bronze → Silver → Gold`), `PyIceberg`, dan `DuckDB`.

## Menjalankan Lokal

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`.

## Halaman Utama
- **`/` (Ikhtisar APBD — Gold):** Dashboard eksekutif dengan Time-Travel Snapshot switcher (`Murni 2026`, `Pergeseran I`, `PAK 2026`), 5 KPI interaktif, ringkasan pipeline Medallion Iceberg, dan tabel serapan per OPD.
- **`/catalog` (Katalog Iceberg):** Daftar tabel `bronze.*`, `silver.*`, `gold.*`, inspeksi skema & upstream lineage, serta riwayat snapshot Time-Travel.
- **`/ingest` (Unified Ingestion & Web Scraper):** Upload multi-format (`.xlsx`, `.csv`, `.pdf`, gambar/scan OCR) dan URL web scraper (`surabaya.go.id`) dengan deduplikasi SHA-256 dan antrean review.
- **`/sql` (SQL Explorer):** Workbench query DuckDB SQL langsung ke tabel Iceberg (termasuk preset *Time-Travel Murni vs PAK*) + Export CSV.
