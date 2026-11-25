"use client";

import React, { useState } from "react";
import { FileSpreadsheet, FileText, Globe, Image as ImageIcon, UploadCloud } from "lucide-react";
import { useLakehouse } from "@/components/LakehouseContext";
import type { IngestRecord } from "@/lib/lakehouse-data";

export default function IngestPage() {
  const { ingestRecords, addIngestRecord } = useLakehouse();
  const [tab, setTab] = useState<"file" | "web">("file");
  const [urlInput, setUrlInput] = useState(
    "https://surabaya.go.id/id/page/0/25199/rencana-kerja-anggaran-rka-skpd-tahun-2026"
  );
  const [syncRunning, setSyncRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const detectType = (filename: string): IngestRecord["sourceType"] => {
    const ext = filename.split(".").pop()?.toLowerCase();
    if (ext === "xlsx" || ext === "xls") return "xlsx";
    if (ext === "csv") return "csv";
    if (ext === "pdf") return "pdf";
    return "image";
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const sourceType = detectType(file.name);
      const targetTable =
        sourceType === "xlsx" || sourceType === "csv"
          ? "bronze.tabular_upload_raw"
          : sourceType === "pdf"
          ? "bronze.pdf_documents_raw"
          : "bronze.media_ocr_raw";

      addIngestRecord({
        id: `ing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sourceName: file.name,
        sourceType,
        targetTable,
        sha256: Math.random().toString(16).slice(2, 10),
        rowsExtracted: sourceType === "image" ? 1 : 0,
        ingestedAt: "Baru saja",
        status: sourceType === "image" || sourceType === "pdf" ? "Perlu Review" : "Committed",
      });
    });

    setLogs([
      `[Ingest] ${files.length} berkas diterima di staging frontend. Hubungkan endpoint FastAPI (/api/ingest) untuk menulis langsung ke Apache Iceberg Bronze.`,
    ]);
    e.target.value = "";
  };

  const handleWebScrape = () => {
    if (syncRunning || !urlInput.trim()) return;
    setSyncRunning(true);
    setLogs([`[Harvester] GET ${urlInput} -> memindai tautan dokumen RKA & teks...`]);

    setTimeout(() => {
      setLogs((prev) => [
        ...prev,
        "[Parser] Menghitung SHA-256 lampiran PDF & menjalankan pdfplumber...",
      ]);
    }, 550);

    setTimeout(() => {
      setLogs((prev) => [
        ...prev,
        "[PyIceberg] Commit selesai -> metadata snapshot siap di bronze.rka_web_harvest.",
      ]);
      addIngestRecord({
        id: `web-${Date.now()}`,
        sourceName: urlInput.replace(/^https?:\/\//, "").slice(0, 52),
        sourceType: "web",
        targetTable: "bronze.rka_web_harvest",
        sha256: Math.random().toString(16).slice(2, 10),
        rowsExtracted: 1240,
        ingestedAt: "Baru saja",
        status: "Committed",
      });
      setSyncRunning(false);
    }, 1150);
  };

  const typeIcon = (t: IngestRecord["sourceType"]) => {
    if (t === "xlsx" || t === "csv") return <FileSpreadsheet className="w-4 h-4 text-[var(--muted)]" />;
    if (t === "pdf") return <FileText className="w-4 h-4 text-[var(--muted)]" />;
    if (t === "image") return <ImageIcon className="w-4 h-4 text-[var(--muted)]" />;
    return <Globe className="w-4 h-4 text-[var(--muted)]" />;
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            Unified Ingestion &amp; Web Scraper
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            Satu pintu masuk untuk{" "}
            <strong className="font-medium text-[var(--text)]">
              Excel (.xlsx), CSV, PDF, Gambar/Scan (OCR), dan Website URL
            </strong>{" "}
            ke Apache Iceberg Bronze.
          </p>
        </div>
      </div>

      {/* Mode Tabs */}
      <div className="flex items-center gap-5 border-b border-[var(--border)]">
        <button
          type="button"
          onClick={() => setTab("file")}
          className={`pb-2.5 pt-2 -mb-px text-[14px] font-medium border-b-2 cursor-pointer ${
            tab === "file"
              ? "border-[var(--accent)] text-[var(--text)]"
              : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          Upload Berkas (XLSX, CSV, PDF, Gambar)
        </button>
        <button
          type="button"
          onClick={() => setTab("web")}
          className={`pb-2.5 pt-2 -mb-px text-[14px] font-medium border-b-2 cursor-pointer ${
            tab === "web"
              ? "border-[var(--accent)] text-[var(--text)]"
              : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
          }`}
        >
          Sumber Website / URL Scraper
        </button>
      </div>

      {tab === "file" ? (
        <section className="bg-white border border-[var(--border)] rounded-lg p-5">
          <label
            htmlFor="fileUpload"
            className="flex flex-col items-center justify-center gap-2 border border-dashed border-[var(--control)] rounded-lg p-8 bg-[var(--ground)] hover:bg-[var(--raised)] cursor-pointer transition-colors"
          >
            <UploadCloud className="w-6 h-6 text-[var(--accent)]" />
            <span className="text-[14px] font-medium text-[var(--text)]">
              Pilih atau tarik berkas ke sini
            </span>
            <span className="text-[13px] text-[var(--muted)]">
              Mendukung .xlsx, .csv, .pdf, .png, .jpg · Auto-detect parser &amp; deduplikasi SHA-256
            </span>
            <input
              id="fileUpload"
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp"
              onChange={handleFileChange}
              className="sr-only"
            />
          </label>
        </section>
      ) : (
        <section className="bg-white border border-[var(--border)] rounded-lg p-5 flex flex-col gap-3">
          <div>
            <h2 className="text-[16px] font-semibold">Connector URL / Portal Resmi</h2>
            <p className="text-[13px] text-[var(--muted)] mt-0.5">
              Mengunduh teks halaman &amp; lampiran PDF/Excel secara otomatis dengan rate-limiting.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://surabaya.go.id/..."
              className="flex-1 h-9 px-3 rounded-md border border-[var(--control)] bg-white font-mono-code text-[13px]"
            />
            <button
              type="button"
              disabled={syncRunning}
              onClick={handleWebScrape}
              className="h-9 px-4 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
            >
              {syncRunning ? "Menjalankan Sync..." : "Jalankan Sync Sekarang"}
            </button>
          </div>
        </section>
      )}

      {logs.length > 0 && (
        <div className="bg-[var(--ground)] border border-[var(--border)] rounded-lg px-4 py-3 font-mono-code text-[12px] text-[var(--text)] flex flex-col gap-1">
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}

      {/* Ingestion Log Table */}
      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="mb-4">
          <h2 className="text-[16px] font-semibold">Riwayat Ingestion &amp; Antrean Review</h2>
          <p className="text-[12px] text-[var(--faint)] mt-0.5">
            PDF scan &amp; gambar dengan confidence rendah otomatis ditandai Perlu Review sebelum dipromosikan ke Silver/Gold.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                <th className="text-left font-medium pb-2.5 pr-3">Sumber</th>
                <th className="text-left font-medium pb-2.5 pr-3">Target Bronze</th>
                <th className="text-left font-medium pb-2.5 pr-3">SHA-256</th>
                <th className="text-right font-medium pb-2.5 pr-3">Baris</th>
                <th className="text-right font-medium pb-2.5 pr-3">Waktu</th>
                <th className="text-left font-medium pb-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {ingestRecords.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                >
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-2">
                      {typeIcon(r.sourceType)}
                      <span className="font-medium text-[var(--text)]">
                        {r.sourceName}
                      </span>
                    </div>
                  </td>
                  <td className="font-mono-code text-[13px] py-3 pr-3">
                    {r.targetTable}
                  </td>
                  <td className="font-mono-code text-[13px] text-[var(--faint)] py-3 pr-3">
                    {r.sha256}...
                  </td>
                  <td className="text-right tabular-nums py-3 pr-3">
                    {r.rowsExtracted.toLocaleString("id-ID")}
                  </td>
                  <td className="text-right tabular-nums py-3 pr-3 text-[13px]">
                    {r.ingestedAt}
                  </td>
                  <td className="py-3">
                    {r.status === "Committed" ? (
                      <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-positive-bg)] text-[var(--pill-positive-ink)]">
                        Committed
                      </span>
                    ) : r.status === "Perlu Review" ? (
                      <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]">
                        Perlu Review
                      </span>
                    ) : (
                      <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]">
                        Unchanged
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
