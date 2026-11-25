"use client";

import React, { useMemo, useState } from "react";
import { useLakehouse } from "@/components/LakehouseContext";
import type { IcebergSnapshot } from "@/lib/lakehouse-data";

interface QueryResult {
  elapsedMs: number;
  columns: string[];
  numericCols: Set<string>;
  rows: string[][];
}

interface SqlPreset {
  id: string;
  label: string;
  sql: string;
  run: (snap: IcebergSnapshot, allSnaps: IcebergSnapshot[]) => QueryResult;
}

const PRESETS: SqlPreset[] = [
  {
    id: "lagging",
    label: "OPD Serapan < 70%",
    sql: `SELECT kode_opd, nama_opd, pagu_miliar, realisasi_miliar,
       ROUND(realisasi_miliar / pagu_miliar * 100, 1) AS serapan_pct
FROM iceberg_scan('warehouse/gold/apbd_opd_summary')
WHERE (realisasi_miliar / pagu_miliar * 100) < 70.0
ORDER BY serapan_pct ASC;`,
    run: (snap) => {
      const rows = snap.opd
        .map((o) => ({ ...o, serapan: +((o.realisasiM / o.paguM) * 100).toFixed(1) }))
        .filter((o) => o.serapan < 70.0)
        .sort((a, b) => a.serapan - b.serapan);
      return {
        elapsedMs: 14,
        columns: ["kode_opd", "nama_opd", "pagu_miliar", "realisasi_miliar", "serapan_pct"],
        numericCols: new Set(["pagu_miliar", "realisasi_miliar", "serapan_pct"]),
        rows: rows.map((r) => [
          r.kode,
          r.nama,
          `Rp ${r.paguM.toLocaleString("id-ID")} M`,
          `Rp ${r.realisasiM.toLocaleString("id-ID")} M`,
          `${r.serapan.toFixed(1).replace(".", ",")}%`,
        ]),
      };
    },
  },
  {
    id: "timetravel",
    label: "Time-Travel: Murni vs PAK",
    sql: `SELECT p.nama_opd,
       m.pagu_miliar AS pagu_murni,
       p.pagu_miliar AS pagu_pak,
       (p.pagu_miliar - m.pagu_miliar) AS selisih_miliar
FROM iceberg_scan('warehouse/gold/apbd_opd_summary', snapshot => 'snap_94a8f10c') p
JOIN iceberg_scan('warehouse/gold/apbd_opd_summary', snapshot => 'snap_40e19a88') m
  USING (kode_opd)
ORDER BY selisih_miliar DESC
LIMIT 6;`,
    run: (_snap, allSnaps) => {
      const pak = allSnaps[0].opd;
      const murni = allSnaps[2].opd;
      const joined = pak
        .map((p) => {
          const m = murni.find((x) => x.kode === p.kode)!;
          return { nama: p.nama, murni: m.paguM, pak: p.paguM, diff: p.paguM - m.paguM };
        })
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 6);
      return {
        elapsedMs: 21,
        columns: ["nama_opd", "pagu_murni", "pagu_pak", "selisih_miliar"],
        numericCols: new Set(["pagu_murni", "pagu_pak", "selisih_miliar"]),
        rows: joined.map((r) => [
          r.nama,
          `Rp ${r.murni.toLocaleString("id-ID")} M`,
          `Rp ${r.pak.toLocaleString("id-ID")} M`,
          `+Rp ${r.diff.toLocaleString("id-ID")} M`,
        ]),
      };
    },
  },
  {
    id: "top5",
    label: "Top 5 Pagu Terbesar",
    sql: `SELECT kode_opd, nama_opd, urusan, pagu_miliar, sub_kegiatan
FROM iceberg_scan('warehouse/gold/apbd_opd_summary')
ORDER BY pagu_miliar DESC
LIMIT 5;`,
    run: (snap) => {
      const rows = [...snap.opd].sort((a, b) => b.paguM - a.paguM).slice(0, 5);
      return {
        elapsedMs: 11,
        columns: ["kode_opd", "nama_opd", "urusan", "pagu_miliar", "sub_kegiatan"],
        numericCols: new Set(["pagu_miliar", "sub_kegiatan"]),
        rows: rows.map((r) => [
          r.kode,
          r.nama,
          r.urusan,
          `Rp ${r.paguM.toLocaleString("id-ID")} M`,
          r.subKegiatan.toLocaleString("id-ID"),
        ]),
      };
    },
  },
];

export default function SqlExplorerPage() {
  const { snapshots, currentSnapshot } = useLakehouse();
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [sqlText, setSqlText] = useState(PRESETS[0].sql);
  const [runVersion, setRunVersion] = useState(0);

  const result = useMemo(() => {
    void runVersion;
    const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
    return preset.run(currentSnapshot, snapshots);
  }, [presetId, currentSnapshot, snapshots, runVersion]);

  const exportCsv = () => {
    const csv = [
      result.columns.join(","),
      ...result.rows.map((r) =>
        r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suralake_${presetId}_${currentSnapshot.id}.csv`;
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
            Jalankan query analitik langsung ke file Parquet Apache Iceberg tanpa
            migrasi ke database relasional terpisah.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)] cursor-pointer"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => setRunVersion((v) => v + 1)}
            className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] cursor-pointer"
          >
            Jalankan Query
          </button>
        </div>
      </div>

      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[16px] font-semibold">Query Editor</h2>
          <span className="font-mono-code text-[12px] text-[var(--faint)]">
            Snapshot aktif: {currentSnapshot.id}
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPresetId(p.id);
                setSqlText(p.sql);
              }}
              className={`h-7 px-2.5 rounded-md border text-[12px] cursor-pointer ${
                presetId === p.id
                  ? "border-[var(--accent)] bg-[#f2f8f6] text-[var(--text)] font-medium"
                  : "border-[var(--border)] bg-white text-[var(--muted)] hover:border-[var(--accent)]"
              }`}
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
      </section>

      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[16px] font-semibold">Hasil Query</h2>
          <span className="font-mono-code text-[12px] text-[var(--faint)]">
            {result.rows.length} baris · {result.elapsedMs} ms (DuckDB local)
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                {result.columns.map((col) => (
                  <th
                    key={col}
                    className={`font-mono-code font-medium pb-2.5 pr-3 ${
                      result.numericCols.has(col) ? "text-right" : "text-left"
                    }`}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={result.columns.length}
                    className="py-4 text-[13px] text-[var(--faint)]"
                  >
                    Query berhasil dijalankan, 0 baris cocok pada snapshot ini.
                  </td>
                </tr>
              ) : (
                result.rows.map((row, ri) => (
                  <tr
                    key={ri}
                    className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                  >
                    {row.map((cell, ci) => {
                      const col = result.columns[ci];
                      return (
                        <td
                          key={ci}
                          className={`py-3 pr-3 ${
                            result.numericCols.has(col)
                              ? "text-right tabular-nums"
                              : "text-left"
                          } ${col.includes("kode") ? "font-mono-code text-[13px]" : ""}`}
                        >
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
