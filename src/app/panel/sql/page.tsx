"use client";

import React, { useState } from "react";
import { useLakehouse } from "@/components/LakehouseContext";
import { executeSql, saveSqlAsGold, type SqlResponse } from "@/lib/api";

const PRESETS = [
  {
    label: "Top 10 OPD Alokasi Terbesar",
    sql: `SELECT nama_opd, alokasi_rp, sp2d_rp, serapan_sp2d_pct, jumlah_anomali
FROM gold.apbd_opd_summary
ORDER BY alokasi_rp DESC
LIMIT 10;`,
  },
  {
    label: "Cek Anomali Fisik > 100%",
    sql: `SELECT nama_opd, kode_sub_kegiatan, nama_pekerjaan, rencana_fisik_pct, dq_flag
FROM gold.dq_anomaly_audit
LIMIT 20;`,
  },
  {
    label: "JOIN Monitoring × eBudgeting",
    sql: `SELECT m.nama_opd, m.kode_sub_kegiatan,
       COUNT(DISTINCT m.id_pekerjaan) AS paket_monitoring,
       COUNT(e.nama_komponen) AS komponen_ebudgeting
FROM silver.monitoring_pekerjaan m
JOIN silver.ebudgeting_rincian e
  USING (kode_sub_kegiatan)
GROUP BY 1, 2
LIMIT 15;`,
  },
];

export default function SqlExplorerPage() {
  const { catalog, refreshAll } = useLakehouse();
  const [sqlText, setSqlText] = useState(PRESETS[0].sql);
  const [result, setResult] = useState<SqlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [goldName, setGoldName] = useState("custom_summary");
  const [savingGold, setSavingGold] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const handleSaveGold = async () => {
    if (!goldName.trim()) return;
    setSavingGold(true);
    setError(null);
    setSaveNotice(null);
    try {
      const res = await saveSqlAsGold(sqlText, goldName.trim());
      setSaveNotice(
        `Tersimpan ke ${res.table} (${res.rows.toLocaleString("id-ID")} baris · snapshot ${res.snapshot_id})`
      );
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingGold(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await executeSql(sqlText);
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = () => {
    if (!result) return;
    const cell = (v: string) => {
      // A leading =, +, @ or non-numeric - would run as a formula in Excel.
      const safe = /^[=+@\t\r]|^-(?!\d+(\.\d+)?$)/.test(v) ? `'${v}` : v;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [result.columns, ...result.rows].map((r) => r.map(cell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suralake_query.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            SQL Explorer (DuckDB + Iceberg)
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            Eksekusi SQL baca (SELECT / WITH) langsung ke tabel Apache Iceberg yang terdaftar ({catalog.tables.length} tabel aktif).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!result}
            onClick={exportCsv}
            className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)] disabled:opacity-50 cursor-pointer"
          >
            Export CSV
          </button>
          <button
            type="button"
            disabled={running}
            onClick={handleRun}
            className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
          >
            {running ? "Menjalankan..." : "Jalankan Query"}
          </button>
        </div>
      </div>

      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[16px] font-semibold">Query Editor</h2>
          <span className="font-mono-code text-[12px] text-[var(--faint)]">
            Engine: DuckDB · PyIceberg
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setSqlText(p.sql)}
              className="h-7 px-2.5 rounded-md border border-[var(--border)] bg-white text-[12px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--text)] cursor-pointer"
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          value={sqlText}
          onChange={(e) => setSqlText(e.target.value)}
          spellCheck={false}
          aria-label="Editor SQL DuckDB"
          className="w-full min-h-[132px] p-3.5 rounded-md border border-[var(--border)] bg-[var(--ground)] font-mono-code text-[13px] leading-5 text-[var(--text)] resize-y focus:outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-3 pt-3 border-t border-[var(--rule)] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono-code text-[12px] text-[var(--faint)]">gold.</span>
            <input
              type="text"
              value={goldName}
              onChange={(e) => setGoldName(e.target.value)}
              placeholder="nama_tabel_gold"
              className="h-8 px-2.5 rounded-md border border-[var(--control)] bg-white font-mono-code text-[13px] w-48"
            />
            <button
              type="button"
              disabled={savingGold || !goldName.trim()}
              onClick={handleSaveGold}
              className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)] disabled:opacity-50 cursor-pointer"
            >
              {savingGold ? "Menyimpan..." : "Simpan sebagai Tabel Gold"}
            </button>
          </div>
          {saveNotice && (
            <span className="text-[12px] font-medium text-[var(--accent)]">{saveNotice}</span>
          )}
        </div>
      </section>

      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[16px] font-semibold">Hasil Query</h2>
          {result && (
            <span className="font-mono-code text-[12px] text-[var(--faint)]">
              {result.rowCount} baris · {result.elapsedMs} ms
            </span>
          )}
        </div>

        {result?.truncated && (
          <p className="mb-3 p-3 rounded-md bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)] text-[13px]">
            Hasil dipotong: hanya {result.rowCount} baris pertama yang ditampilkan dan diekspor. Persempit query
            dengan WHERE, atau ambil bertahap dengan LIMIT dan OFFSET.
          </p>
        )}

        {error ? (
          <div className="p-3 rounded-md bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)] text-[13px] font-mono-code">
            {error}
          </div>
        ) : !result ? (
          <p className="text-[13px] text-[var(--faint)]">
            {catalog.tables.length === 0
              ? "Belum ada tabel Iceberg. Unggah data terlebih dahulu di menu Ingest & Scraper."
              : "Klik Jalankan Query untuk mengeksekusi SQL di DuckDB."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[12px] text-[var(--faint)]">
                  {result.columns.map((col) => (
                    <th key={col} className="font-mono-code text-left font-medium pb-2.5 pr-3">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td colSpan={result.columns.length} className="py-4 text-[var(--faint)]">
                      0 baris dikembalikan.
                    </td>
                  </tr>
                ) : (
                  result.rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                    >
                      {row.map((cell, ci) => (
                        <td key={ci} className="py-2.5 pr-3 tabular-nums">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
