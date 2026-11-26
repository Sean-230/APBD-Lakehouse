# SuraLake — APBD Surabaya AI & Data Lakehouse

**SuraLake** adalah platform **Data Lakehouse** dan **Asisten AI** untuk mengelola, membersihkan, mengaudit, memvisualisasikan, serta menanyakan data **APBD Kota Surabaya** (Monitoring Realisasi/SP2D, eBudgeting, dokumen PDF RKA, gambar/OCR, CSV, dan hasil scraping portal resmi `surabaya.go.id`).

Seluruh siklus data mengikuti **Medallion Architecture** berbasis **Apache Iceberg**:

```
Upload / Web Scrape  ──►  1. BRONZE (Mentah)  ──►  2. SILVER (Bersih)  ──►  3. GOLD (Kurasi/Ringkasan)  ──►  4. VECTOR AI (Gold-only)
                                                                                     │                                 │
                                                                                     ▼                                 ▼
                                                                           Dashboard Visual & SQL              Hybrid Groq Chatbot
```

---

## Fitur Utama & Halaman

| Rute | Halaman | Fungsi |
| :--- | :--- | :--- |
| **`/`** | **SuraLake AI Chatbot** | Antarmuka tanya-jawab publik berbasis **Groq AI** yang terhubung secara *hybrid* ke **DuckDB SQL** (untuk hitungan angka eksak) dan **Vector Search lokal** (untuk pencarian semantik teks/dokumen/rincian kegiatan). |
| **`/panel`** | **Ikhtisar APBD (Visual)** | Dashboard ramah non-teknis: Donut Ring serapan kota, batang perbandingan 8 dinas anggaran terbesar, sorotan serapan terendah & tertinggi, grafik anggaran prioritas (Pendidikan, Kemiskinan, Stunting, Infrastruktur), serta switch **Kartu Visual / Tabel Detail**. |
| **`/panel/catalog`** | **Katalog Iceberg, Pipeline Visual & CRUD** | Papan alur visual interaktif 4 tahap (**Bronze → Silver → Gold → Vector AI**), *lineage highlighting*, *progress stepper*, uji *semantic search* langsung, riwayat snapshot Apache Iceberg, serta **CRUD lengkap** (tambah/edit/hapus baris & hapus tabel). |
| **`/panel/ingest`** | **Unified Ingestion & Web Scraper** | Upload berkas `.xlsx`, `.csv`, `.pdf`, dan gambar (`.png`, `.jpg`, `.webp` dengan ekstraksi teks **RapidOCR** otomatis), serta web scraper URL (mis. `surabaya.go.id`) yang masuk ke layer **Bronze**. |
| **`/panel/sql`** | **DuckDB SQL Explorer** | Eksekusi query `SELECT` / `WITH` langsung atas seluruh tabel `bronze.*`, `silver.*`, dan `gold.*`, export CSV, serta simpan hasil query sebagai tabel `gold.*` baru. |

---

## Tech Stack

- **Frontend:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4, Lucide Icons, IBM Plex Sans & IBM Plex Mono.
- **Backend API:** Python, FastAPI, Uvicorn, Pydantic, HTTPX, BeautifulSoup4, OpenPyXL, PDFPlumber.
- **Data Lakehouse & Query Engine:**
  - **Apache Iceberg (`PyIceberg`)** + **PyArrow** — penyimpanan file **Parquet** terversi (*snapshots*, ACID, evolusi skema) dengan SQLite Catalog lokal (`warehouse/catalog.db`).
  - **DuckDB** — mesin analitik SQL super cepat (*in-memory*, *read-only sandboxed*) untuk transformasi Silver → Gold, SQL Explorer, dan tool-calling AI.
- **AI, Vector Search & OCR:**
  - **Groq API** (`openai/gpt-oss-120b` dengan fallback `openai/gpt-oss-20b` & `qwen/qwen3.8-27b`) + *Tool Calling*.
  - **FastEmbed (`paraphrase-multilingual-MiniLM-L12-v2`, ONNX)** — embedding lokal gratis tanpa kuota API, disimpan di `warehouse/vectors.parquet` (khusus layer **Gold**).
  - **RapidOCR (`rapidocr-onnxruntime`)** — ekstraksi teks lokal dari berkas gambar `PNG`/`JPG`/`WEBP`.

---

## Struktur Proyek

```text
APBD Lakehouse/
├── backend/
│   ├── main.py              # FastAPI endpoints (Ingest, CRUD, Transform, SQL, Vector, Chat)
│   ├── lakehouse.py         # PyIceberg Catalog, Medallion ETL, DuckDB sandbox, SSRF guard
│   ├── vector_store.py      # FastEmbed lokal, RapidOCR, cosine similarity search (Gold-only)
│   ├── chatbot.py           # Groq AI Agent (Hybrid DuckDB SQL + Vector Search tools)
│   ├── requirements.txt     # Dependensi Python
│   └── .env                 # API key Groq (lokal, gitignored)
├── src/
│   ├── app/
│   │   ├── page.tsx         # Halaman utama: Chatbot APBD (/)
│   │   └── panel/
│   │       ├── layout.tsx   # Shell & Sidebar khusus /panel
│   │       ├── page.tsx     # Dashboard Visual Ikhtisar APBD (/panel)
│   │       ├── catalog/     # Visual Medallion Canvas, CRUD, & Snapshot (/panel/catalog)
│   │       ├── ingest/      # Upload Multi-Format & URL Scraper (/panel/ingest)
│   │       └── sql/         # DuckDB SQL Explorer & Simpan ke Gold (/panel/sql)
│   ├── components/
│   │   ├── AppShell.tsx
│   │   ├── LakehouseContext.tsx
│   │   └── MedallionFlowCanvas.tsx
│   └── lib/
│       └── api.ts           # Typed API client ke FastAPI
└── warehouse/               # Penyimpanan data lokal (otomatis dibuat, gitignored)
    ├── catalog.db           # SQLite Apache Iceberg Catalog
    ├── iceberg/             # File Parquet & metadata (bronze/, silver/, gold/)
    ├── raw/                 # Arsip berkas mentah hasil upload
    ├── vectors.parquet      # Vector index lokal dari layer Gold
    └── ingest_log.json      # Riwayat ingest & scraping
```

---

## Cara Menjalankan Program (Lokal)

### Prasyarat
- **Node.js** `>= 20` & **npm**
- **Python** `>= 3.11` (disarankan `3.12`)
- **Groq API Key** (didapatkan dari [console.groq.com](https://console.groq.com))

### 1. Konfigurasi Environment Backend
Buat file `backend/.env`:

```env
GROQ_API_KEY=gsk_isi_api_key_groq_anda
GROQ_MODEL=openai/gpt-oss-120b
```

Buat juga file `.env.local` di root proyek. Tanpa kata sandi ini, `/panel` dan semua API selain chat terkunci:

```env
ADMIN_PASSWORD=ganti_dengan_kata_sandi_kuat
```

Saat browser meminta login, nama pengguna boleh apa saja.

### 2. Jalankan Backend (FastAPI — Port `8000`)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

uvicorn main:app --port 8000 --reload
```

### 3. Jalankan Frontend (Next.js — Port `3000`)
Buka terminal baru di root proyek:

```bash
npm install
npm run dev
```

### 4. Akses Aplikasi
- **Chatbot AI (Publik):** [http://localhost:3000](http://localhost:3000)
- **Panel Lakehouse (Admin/Analis):** [http://localhost:3000/panel](http://localhost:3000/panel)
- **Swagger API Docs (FastAPI):** [http://localhost:8000/docs](http://localhost:8000/docs)

---

### Menjalankan Test Backend
```bash
cd backend && .venv/bin/python -m unittest -v
```

### Catatan untuk Docker / Server
- Publikasikan **hanya port frontend**. Port backend `8000` tidak punya login, jadi jangan dibuka ke jaringan.
- Di container frontend, set `BACKEND_URL` **saat build** dan `ADMIN_PASSWORD` **saat jalan**, lalu build ulang image setelah memperbarui kode.
- Jalankan backend dengan **satu worker** uvicorn.
- Index vector untuk ±10.000 baris butuh sekitar 2 menit dan 1,5 GB RAM di laptop; sediakan minimal 2 GB untuk container backend.

---

## Alur Penggunaan Data

1. Buka **`/panel/ingest`**, unggah berkas (`Monitoring Semua PD.xlsx`, `Tabel eBudgeting.xlsx`, CSV, PDF, gambar) atau masukkan URL web → data masuk ke **1. BRONZE**.
2. Buka **`/panel/catalog`**, pada papan visual klik **“Ke Silver →”** untuk membersihkan, menormalisasi kode, dan menandai anomali data → masuk ke **2. SILVER**.
3. Klik **“Ke Gold →”** pada kartu Silver untuk menyusun data mart ringkasan & detail terkurasi (khusus tahap `PAK` agar bebas *double-counting*) → masuk ke **3. GOLD**.
4. Klik **“Ke Vector →”** (atau **“Index Semua Gold ke Vector”**) agar data Gold terindeks ke **4. VECTOR AI**. Satu baris menjadi satu *chunk* (teks PDF/OCR yang panjang menjadi beberapa chunk). Setelah tabel Gold berubah, index ulang karena vector lamanya dihapus otomatis.
5. Buka **`/`** dan tanyakan apa saja soal APBD Surabaya ke **SuraLake AI**.

---

## Keamanan & Penyimpanan Lokal

- **Data & Rahasia Aman di Lokal:** Folder `warehouse/` dan berkas `backend/.env` sudah masuk `.gitignore`.
- **SQL Read-Only Sandbox:** Query di SQL Explorer & AI Tool divalidasi hanya 1 statement `SELECT`/`WITH` serta menjalankan `SET enable_external_access = false` di DuckDB, dengan batas waktu 30 detik dan maksimal 500 baris hasil.
- **Proteksi SSRF:** Web scraper otomatis memblokir `localhost`, loopback, dan alamat IP jaringan internal/privat.
- **Gold-Only Vector Governance:** Hanya tabel di layer `gold.*` yang diizinkan masuk ke Vector Store; menghapus tabel Gold otomatis membersihkan vector terkait.
