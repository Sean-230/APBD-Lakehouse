export type MedallionLayer = "bronze" | "silver" | "gold";

export interface OpdRow {
  kode: string;
  nama: string;
  urusan: string;
  paguM: number;
  realisasiM: number;
  targetPct: number;
  subKegiatan: number;
  anomali: number;
}

export interface IcebergSnapshot {
  id: string;
  label: string;
  shortLabel: string;
  committedAt: string;
  source: string;
  parquetFiles: number;
  sizeMb: number;
  parent: string | null;
  summary: string;
  opd: OpdRow[];
  monthlyLabels: string[];
  monthlyRealisasi: number[];
  monthlyTarget: number[];
  monthlyRowsIngested: number[];
  monthlyQueryMs: number[];
}

export interface CatalogColumn {
  name: string;
  type: string;
  sample: string;
}

export interface CatalogTable {
  name: string;
  layer: MedallionLayer;
  format: string;
  rows: number;
  files: number;
  sizeMb: number;
  snapshotId: string;
  updatedAt: string;
  partition: string;
  description: string;
  upstream: string[];
  columns: CatalogColumn[];
}

export interface IngestRecord {
  id: string;
  sourceName: string;
  sourceType: "xlsx" | "csv" | "pdf" | "image" | "web";
  targetTable: string;
  sha256: string;
  rowsExtracted: number;
  ingestedAt: string;
  status: "Committed" | "Perlu Review" | "Unchanged";
}

export const ICEBERG_SNAPSHOTS: IcebergSnapshot[] = [
  {
    id: "snap_94a8f10c",
    label: "APBD Perubahan (PAK) 2026",
    shortLabel: "PAK 2026",
    committedAt: "2026-11-24 14:22 WIB",
    source: "surabaya.go.id + eBudgeting + Monitoring PD",
    parquetFiles: 18,
    sizeMb: 42.6,
    parent: "snap_71c3b204",
    summary:
      "Pembaruan pagu Perubahan (PAK) dan sinkronisasi realisasi SP2D Triwulan III.",
    opd: [
      { kode: "1.01.01", nama: "Dinas Pendidikan", urusan: "Pendidikan", paguM: 2840, realisasiM: 2215, targetPct: 76.0, subKegiatan: 148, anomali: 0 },
      { kode: "1.02.01", nama: "Dinas Kesehatan", urusan: "Kesehatan", paguM: 1960, realisasiM: 1490, targetPct: 75.0, subKegiatan: 112, anomali: 1 },
      { kode: "1.03.01", nama: "Dinas Sumber Daya Air & Bina Marga", urusan: "Pekerjaan Umum", paguM: 2150, realisasiM: 1256, targetPct: 72.0, subKegiatan: 94, anomali: 2 },
      { kode: "1.04.01", nama: "Dinas Perumahan Rakyat & Kawasan Permukiman", urusan: "Perumahan", paguM: 1120, realisasiM: 710, targetPct: 70.0, subKegiatan: 67, anomali: 1 },
      { kode: "2.11.01", nama: "Dinas Lingkungan Hidup", urusan: "Lingkungan Hidup", paguM: 840, realisasiM: 647, targetPct: 74.0, subKegiatan: 53, anomali: 0 },
      { kode: "2.15.01", nama: "Dinas Perhubungan", urusan: "Perhubungan", paguM: 760, realisasiM: 486, targetPct: 72.0, subKegiatan: 49, anomali: 0 },
      { kode: "1.06.01", nama: "Dinas Sosial", urusan: "Sosial", paguM: 620, realisasiM: 502, targetPct: 78.0, subKegiatan: 41, anomali: 0 },
      { kode: "1.05.01", nama: "Satuan Polisi Pamong Praja", urusan: "Trantibumlinmas", paguM: 490, realisasiM: 382, targetPct: 76.0, subKegiatan: 34, anomali: 0 },
      { kode: "5.02.01", nama: "Badan Pengelolaan Keuangan & Aset Daerah", urusan: "Keuangan", paguM: 640, realisasiM: 525, targetPct: 80.0, subKegiatan: 38, anomali: 0 },
      { kode: "2.12.01", nama: "Dinas Kependudukan & Pencatatan Sipil", urusan: "Adminduk", paguM: 440, realisasiM: 356, targetPct: 78.0, subKegiatan: 29, anomali: 0 },
    ],
    monthlyLabels: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov"],
    monthlyRealisasi: [420, 980, 1690, 2410, 3260, 4210, 5090, 5980, 6890, 7740, 8569],
    monthlyTarget: [510, 1120, 1850, 2680, 3550, 4520, 5480, 6420, 7380, 8290, 9120],
    monthlyRowsIngested: [14200, 16800, 21400, 19500, 23100, 28900, 26400, 29800, 34200, 31600, 38450],
    monthlyQueryMs: [34, 31, 29, 28, 26, 25, 24, 22, 21, 19, 18],
  },
  {
    id: "snap_71c3b204",
    label: "Pergeseran I 2026",
    shortLabel: "Pergeseran I",
    committedAt: "2026-08-18 09:45 WIB",
    source: "eBudgeting Pemkot Surabaya",
    parquetFiles: 15,
    sizeMb: 36.1,
    parent: "snap_40e19a88",
    summary: "Pergeseran belanja modal drainase dan pengadaan alat kesehatan puskesmas.",
    opd: [
      { kode: "1.01.01", nama: "Dinas Pendidikan", urusan: "Pendidikan", paguM: 2810, realisasiM: 1620, targetPct: 58.0, subKegiatan: 146, anomali: 0 },
      { kode: "1.02.01", nama: "Dinas Kesehatan", urusan: "Kesehatan", paguM: 1890, realisasiM: 1096, targetPct: 57.0, subKegiatan: 109, anomali: 1 },
      { kode: "1.03.01", nama: "Dinas Sumber Daya Air & Bina Marga", urusan: "Pekerjaan Umum", paguM: 2040, realisasiM: 918, targetPct: 55.0, subKegiatan: 91, anomali: 1 },
      { kode: "1.04.01", nama: "Dinas Perumahan Rakyat & Kawasan Permukiman", urusan: "Perumahan", paguM: 1090, realisasiM: 523, targetPct: 54.0, subKegiatan: 65, anomali: 0 },
      { kode: "2.11.01", nama: "Dinas Lingkungan Hidup", urusan: "Lingkungan Hidup", paguM: 820, realisasiM: 492, targetPct: 58.0, subKegiatan: 52, anomali: 0 },
      { kode: "2.15.01", nama: "Dinas Perhubungan", urusan: "Perhubungan", paguM: 740, realisasiM: 362, targetPct: 55.0, subKegiatan: 48, anomali: 0 },
      { kode: "1.06.01", nama: "Dinas Sosial", urusan: "Sosial", paguM: 600, realisasiM: 378, targetPct: 60.0, subKegiatan: 40, anomali: 0 },
      { kode: "1.05.01", nama: "Satuan Polisi Pamong Praja", urusan: "Trantibumlinmas", paguM: 480, realisasiM: 288, targetPct: 58.0, subKegiatan: 34, anomali: 0 },
      { kode: "5.02.01", nama: "Badan Pengelolaan Keuangan & Aset Daerah", urusan: "Keuangan", paguM: 630, realisasiM: 397, targetPct: 62.0, subKegiatan: 38, anomali: 0 },
      { kode: "2.12.01", nama: "Dinas Kependudukan & Pencatatan Sipil", urusan: "Adminduk", paguM: 430, realisasiM: 267, targetPct: 60.0, subKegiatan: 29, anomali: 0 },
    ],
    monthlyLabels: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu"],
    monthlyRealisasi: [420, 980, 1690, 2410, 3260, 4210, 5240, 6341],
    monthlyTarget: [510, 1120, 1850, 2680, 3550, 4520, 5480, 6420],
    monthlyRowsIngested: [14200, 16800, 21400, 19500, 23100, 28900, 26400, 29800],
    monthlyQueryMs: [34, 31, 29, 28, 26, 25, 24, 22],
  },
  {
    id: "snap_40e19a88",
    label: "APBD Murni 2026",
    shortLabel: "Murni 2026",
    committedAt: "2026-01-12 10:05 WIB",
    source: "Perda APBD 2026 (surabaya.go.id)",
    parquetFiles: 12,
    sizeMb: 29.4,
    parent: null,
    summary: "Commit awal penetapan APBD Murni 2026 dari dokumen RKA SKPD resmi.",
    opd: [
      { kode: "1.01.01", nama: "Dinas Pendidikan", urusan: "Pendidikan", paguM: 2790, realisasiM: 140, targetPct: 5.0, subKegiatan: 145, anomali: 0 },
      { kode: "1.02.01", nama: "Dinas Kesehatan", urusan: "Kesehatan", paguM: 1850, realisasiM: 92, targetPct: 5.0, subKegiatan: 108, anomali: 0 },
      { kode: "1.03.01", nama: "Dinas Sumber Daya Air & Bina Marga", urusan: "Pekerjaan Umum", paguM: 1980, realisasiM: 79, targetPct: 4.5, subKegiatan: 89, anomali: 0 },
      { kode: "1.04.01", nama: "Dinas Perumahan Rakyat & Kawasan Permukiman", urusan: "Perumahan", paguM: 1060, realisasiM: 42, targetPct: 4.5, subKegiatan: 64, anomali: 0 },
      { kode: "2.11.01", nama: "Dinas Lingkungan Hidup", urusan: "Lingkungan Hidup", paguM: 810, realisasiM: 41, targetPct: 5.0, subKegiatan: 51, anomali: 0 },
      { kode: "2.15.01", nama: "Dinas Perhubungan", urusan: "Perhubungan", paguM: 730, realisasiM: 29, targetPct: 4.5, subKegiatan: 47, anomali: 0 },
      { kode: "1.06.01", nama: "Dinas Sosial", urusan: "Sosial", paguM: 590, realisasiM: 35, targetPct: 5.5, subKegiatan: 39, anomali: 0 },
      { kode: "1.05.01", nama: "Satuan Polisi Pamong Praja", urusan: "Trantibumlinmas", paguM: 470, realisasiM: 24, targetPct: 5.0, subKegiatan: 33, anomali: 0 },
      { kode: "5.02.01", nama: "Badan Pengelolaan Keuangan & Aset Daerah", urusan: "Keuangan", paguM: 620, realisasiM: 37, targetPct: 6.0, subKegiatan: 38, anomali: 0 },
      { kode: "2.12.01", nama: "Dinas Kependudukan & Pencatatan Sipil", urusan: "Adminduk", paguM: 420, realisasiM: 21, targetPct: 5.0, subKegiatan: 29, anomali: 0 },
    ],
    monthlyLabels: ["Jan"],
    monthlyRealisasi: [540],
    monthlyTarget: [510],
    monthlyRowsIngested: [14200],
    monthlyQueryMs: [34],
  },
];

export function computeSnapshotTotals(snap: IcebergSnapshot) {
  const paguM = snap.opd.reduce((acc, r) => acc + r.paguM, 0);
  const realisasiM = snap.opd.reduce((acc, r) => acc + r.realisasiM, 0);
  const serapanPct = paguM > 0 ? +((realisasiM / paguM) * 100).toFixed(1) : 0;
  const subKegiatanCount = snap.opd.reduce((acc, r) => acc + r.subKegiatan, 0);
  const anomaliCount = snap.opd.reduce((acc, r) => acc + r.anomali, 0);
  return { paguM, realisasiM, serapanPct, opdCount: snap.opd.length, subKegiatanCount, anomaliCount };
}

export const CATALOG_TABLES: CatalogTable[] = [
  {
    name: "bronze.monitoring_pd_raw",
    layer: "bronze",
    format: "Iceberg v2 · Parquet",
    rows: 27728,
    files: 6,
    sizeMb: 4.3,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:20",
    partition: "tahun, periode_laporan",
    description: "Data mentah Laporan Penyerapan & Realisasi 63 Perangkat Daerah (Excel multi-header disimpan 1:1).",
    upstream: ["upload://data_laporan_monitoring_semua_pd_fix.xlsx"],
    columns: [
      { name: "perangkat_daerah", type: "STRING", sample: "Dinas Perindustrian dan Tenaga Kerja" },
      { name: "id_sub_kegiatan_raw", type: "STRING", sample: "2 07 01 2 01 0001 (736)" },
      { name: "nama_sub_kegiatan_raw", type: "STRING", sample: "Penyusunan Dokumen... (PPKm: Drs. ...)" },
      { name: "alokasi_rp_raw", type: "BIGINT", sample: "933403904" },
      { name: "sp2d_rp_raw", type: "BIGINT", sample: "771559215" },
    ],
  },
  {
    name: "bronze.ebudgeting_rincian_raw",
    layer: "bronze",
    format: "Iceberg v2 · Parquet",
    rows: 4790,
    files: 2,
    sizeMb: 0.7,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:20",
    partition: "tahun, tahap",
    description: "Rincian komponen belanja eBudgeting (29 kolom asli termasuk kode rekening & 6 flag prioritas).",
    upstream: ["upload://Tabel eBudgeting.xlsx"],
    columns: [
      { name: "id_skpd", type: "INT", sample: "2000" },
      { name: "nama_skpd", type: "STRING", sample: "Dinas Pendidikan" },
      { name: "kegiatan_id", type: "STRING", sample: "1.01.02.2.03.0011" },
      { name: "rekening", type: "STRING", sample: "5.1.02.01.01.0024" },
      { name: "hasil", type: "BIGINT", sample: "2460035949" },
    ],
  },
  {
    name: "silver.monitoring_pekerjaan",
    layer: "silver",
    format: "Iceberg v2 · Parquet",
    rows: 27728,
    files: 4,
    sizeMb: 2.9,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:21",
    partition: "tahun, kode_sub_kegiatan",
    description: "Monitoring pekerjaan terstandarisasi: kode sub-kegiatan bertitik, PPKm terpisah, tanggal DATE, dan flag DQ.",
    upstream: ["bronze.monitoring_pd_raw"],
    columns: [
      { name: "nama_opd", type: "STRING", sample: "Dinas Perindustrian dan Tenaga Kerja" },
      { name: "kode_sub_kegiatan", type: "STRING", sample: "2.07.01.2.01.0001" },
      { name: "nama_ppkm", type: "STRING", sample: "Drs. BAMBANG UDI UKORO SH, M.Si" },
      { name: "alokasi_rp", type: "BIGINT", sample: "933403904" },
      { name: "dq_flag", type: "STRING", sample: "FISIK_OVER_100" },
    ],
  },
  {
    name: "silver.ebudgeting_rincian",
    layer: "silver",
    format: "Iceberg v2 · Parquet",
    rows: 4790,
    files: 2,
    sizeMb: 0.5,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:21",
    partition: "tahun, nama_opd",
    description: "Komponen belanja eBudgeting siap JOIN dengan Monitoring melalui kunci kode_sub_kegiatan.",
    upstream: ["bronze.ebudgeting_rincian_raw"],
    columns: [
      { name: "nama_opd", type: "STRING", sample: "Dinas Pendidikan" },
      { name: "kode_sub_kegiatan", type: "STRING", sample: "1.01.02.2.03.0011" },
      { name: "sumber_dana", type: "STRING", sample: "PAD" },
      { name: "is_stunting", type: "BOOLEAN", sample: "false" },
      { name: "anggaran_rasionalisasi", type: "BIGINT", sample: "3576949999" },
    ],
  },
  {
    name: "gold.apbd_opd_summary",
    layer: "gold",
    format: "Iceberg v2 · Parquet",
    rows: 63,
    files: 1,
    sizeMb: 0.2,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:22",
    partition: "tahap_apbd",
    description: "Data mart agregasi Alokasi, Penggunaan Dana, Realisasi, SP2D, % Serapan, dan temuan DQ per OPD.",
    upstream: ["silver.monitoring_pekerjaan", "silver.ebudgeting_rincian"],
    columns: [
      { name: "kode_opd", type: "STRING", sample: "1.01.01" },
      { name: "nama_opd", type: "STRING", sample: "Dinas Pendidikan" },
      { name: "pagu_miliar", type: "DECIMAL(12,2)", sample: "2840.00" },
      { name: "realisasi_miliar", type: "DECIMAL(12,2)", sample: "2215.00" },
      { name: "serapan_pct", type: "DECIMAL(5,2)", sample: "78.00" },
    ],
  },
  {
    name: "gold.dq_anomaly_audit",
    layer: "gold",
    format: "Iceberg v2 · Parquet",
    rows: 6721,
    files: 1,
    sizeMb: 0.4,
    snapshotId: "snap_94a8f10c",
    updatedAt: "2026-11-24 14:22",
    partition: "tahun",
    description: "Daftar temuan kualitas data (Fisik > 100%, selisih alokasi vs kontrak) untuk review BPKAD.",
    upstream: ["silver.monitoring_pekerjaan"],
    columns: [
      { name: "rule_id", type: "STRING", sample: "DQ-FISIK-100" },
      { name: "nama_opd", type: "STRING", sample: "Dinas Perindustrian dan Tenaga Kerja" },
      { name: "id_pekerjaan", type: "BIGINT", sample: "26003551" },
      { name: "fisik_pct", type: "DOUBLE", sample: "257.19" },
    ],
  },
];

export const INITIAL_INGEST_RECORDS: IngestRecord[] = [
  {
    id: "ing-01",
    sourceName: "data_laporan_monitoring_semua_pd_fix.xlsx",
    sourceType: "xlsx",
    targetTable: "bronze.monitoring_pd_raw",
    sha256: "8f3e21b9",
    rowsExtracted: 27728,
    ingestedAt: "24 Nov 14:18",
    status: "Committed",
  },
  {
    id: "ing-02",
    sourceName: "Tabel eBudgeting.xlsx",
    sourceType: "xlsx",
    targetTable: "bronze.ebudgeting_rincian_raw",
    sha256: "4a9c10d2",
    rowsExtracted: 4790,
    ingestedAt: "24 Nov 14:18",
    status: "Committed",
  },
  {
    id: "ing-03",
    sourceName: "surabaya.go.id/.../rka-skpd-tahun-2026",
    sourceType: "web",
    targetTable: "bronze.rka_web_harvest",
    sha256: "71bd93e5",
    rowsExtracted: 35820,
    ingestedAt: "24 Nov 14:19",
    status: "Perlu Review",
  },
  {
    id: "ing-04",
    sourceName: "BA-STT-I-Drainase-2026.jpg (OCR)",
    sourceType: "image",
    targetTable: "bronze.media_ocr_raw",
    sha256: "2c88f4a1",
    rowsExtracted: 14,
    ingestedAt: "24 Nov 14:19",
    status: "Perlu Review",
  },
];

export function fmtRpM(m: number): string {
  if (m >= 1000) return `Rp ${(m / 1000).toFixed(2).replace(".", ",")} T`;
  return `Rp ${m.toLocaleString("id-ID")} M`;
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1).replace(".", ",")}%`;
}
