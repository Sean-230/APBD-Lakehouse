# APBD-Lakehouse (SuraLake)

Platform **Data Lakehouse APBD Kota Surabaya** berbasis **Next.js 15 (App Router)** + **FastAPI** + **Apache Iceberg (`PyIceberg`)** + **DuckDB**.

Secara default warehouse dimulai **kosong (0 tabel, 0 data)** agar pengguna bisa langsung menguji alur *end-to-end* mulai dari unggah berkas/URL hingga menjadi tabel `Bronze → Silver → Gold`.

## Menjalankan Lokal (2 Terminal)

### 1. Backend (FastAPI + PyIceberg + DuckDB — port 8000)
```bash
cd "/Users/seantandjaja/Documents/Codes/Genesys/APBD Lakehouse/backend"
source .venv/bin/activate
uvicorn main:app --port 8000 --reload
```

### 2. Frontend (Next.js — port 3000)
```bash
cd "/Users/seantandjaja/Documents/Codes/Genesys/APBD Lakehouse"
npm run dev
```

Buka `http://localhost:3000` dan mulai unggah berkas di menu **Ingest & Scraper** (`/ingest`).
- **Auto-detect format:** Laporan Monitoring Semua PD (`.xlsx`), Tabel eBudgeting (`.xlsx`), CSV/Excel umum, PDF (`pdfplumber`), Gambar (antrean OCR), dan URL website (`surabaya.go.id`).
- **Reset kapan saja:** Klik **Reset Warehouse** di pojok kiri bawah sidebar untuk kembali ke kondisi kosong.
