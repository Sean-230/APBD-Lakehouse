"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useLakehouse } from "@/components/LakehouseContext";
import { SimpleLineChart } from "@/components/SimpleLineChart";
import { computeSnapshotTotals, fmtPct, fmtRpM } from "@/lib/lakehouse-data";

type KpiKey = "pagu" | "realisasi" | "serapan" | "rows" | "anomali";

export default function OverviewPage() {
  const { snapshots, currentSnapshot, searchQuery } = useLakehouse();
  const [activeKpi, setActiveKpi] = useState<KpiKey>("realisasi");
  const [showAll, setShowAll] = useState(false);

  const totals = useMemo(() => computeSnapshotTotals(currentSnapshot), [currentSnapshot]);
  const murniTotals = useMemo(() => computeSnapshotTotals(snapshots[2]), [snapshots]);
  const paguDiff = totals.paguM - murniTotals.paguM;

  const opdWithPct = useMemo(
    () =>
      currentSnapshot.opd.map((o) => ({
        ...o,
        serapan: +((o.realisasiM / o.paguM) * 100).toFixed(1),
      })),
    [currentSnapshot]
  );

  const lagging = opdWithPct.filter(
    (o) => o.serapan < 65 && currentSnapshot.id === "snap_94a8f10c"
  );
  const lowest = [...opdWithPct].sort((a, b) => a.serapan - b.serapan)[0];

  const filteredOpd = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return opdWithPct;
    return opdWithPct.filter(
      (o) =>
        o.nama.toLowerCase().includes(q) ||
        o.kode.includes(q) ||
        o.urusan.toLowerCase().includes(q)
    );
  }, [opdWithPct, searchQuery]);

  const visibleOpd = showAll ? filteredOpd : filteredOpd.slice(0, 6);

  const kpis: {
    id: KpiKey;
    label: string;
    value: string;
    delta: string;
    tone?: "pos" | "neg";
  }[] = [
    {
      id: "pagu",
      label: "Total Pagu APBD",
      value: fmtRpM(totals.paguM),
      delta:
        paguDiff > 0
          ? `+Rp ${paguDiff.toLocaleString("id-ID")} M vs Murni`
          : "Baseline APBD Murni",
      tone: paguDiff > 0 ? "pos" : undefined,
    },
    {
      id: "realisasi",
      label: "Realisasi Belanja",
      value: fmtRpM(totals.realisasiM),
      delta: `${fmtPct(totals.serapanPct)} dari pagu aktif`,
      tone: "pos",
    },
    {
      id: "serapan",
      label: "Rata-rata Serapan",
      value: fmtPct(totals.serapanPct),
      delta: `Target kas ${fmtPct(
        (currentSnapshot.monthlyTarget[currentSnapshot.monthlyTarget.length - 1] /
          totals.paguM) *
          100
      )}`,
    },
    {
      id: "rows",
      label: "Baris Monitoring (Silver)",
      value: "27.728",
      delta: `${currentSnapshot.parquetFiles} file Parquet · ${currentSnapshot.sizeMb} MB`,
    },
    {
      id: "anomali",
      label: "Temuan Kualitas Data",
      value: String(totals.anomaliCount),
      delta:
        totals.anomaliCount > 0 ? "Perlu review di BPKAD" : "Lolos validasi skema",
      tone: totals.anomaliCount > 0 ? "neg" : "pos",
    },
  ];

  const chartConfig = useMemo(() => {
    if (activeKpi === "rows") {
      return {
        title: "Volume Baris Terproses ke Iceberg Silver per Bulan",
        unit: "",
        series: [
          {
            name: "Baris Ingest",
            values: currentSnapshot.monthlyRowsIngested,
            color: "#166553",
          },
        ],
      };
    }
    if (activeKpi === "anomali") {
      return {
        title: "Latensi Query DuckDB pada Tabel Iceberg Gold (ms)",
        unit: " ms",
        series: [
          {
            name: "Latensi DuckDB",
            values: currentSnapshot.monthlyQueryMs,
            color: "#166553",
          },
        ],
      };
    }
    return {
      title: "Realisasi Kumulatif vs Target Kas (Miliar Rp)",
      unit: " M",
      series: [
        {
          name: "Realisasi SP2D",
          values: currentSnapshot.monthlyRealisasi,
          color: "#166553",
        },
        {
          name: "Target Kas",
          values: currentSnapshot.monthlyTarget,
          color: "#2f70bb",
        },
      ],
    };
  }, [activeKpi, currentSnapshot]);

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            Ikhtisar APBD Surabaya 2026
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            {currentSnapshot.id === "snap_94a8f10c" ? (
              <>
                <strong className="font-medium text-[var(--text)]">
                  {lagging.length} OPD serapan di bawah 65%
                </strong>{" "}
                pada Triwulan III (terendah: {lowest.nama} {fmtPct(lowest.serapan)}).
              </>
            ) : (
              <>
                Snapshot historis{" "}
                <strong className="font-medium text-[var(--text)]">
                  {currentSnapshot.label}
                </strong>{" "}
                · {currentSnapshot.summary}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/catalog"
            className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
          >
            Lihat Katalog Iceberg
          </Link>
          <Link
            href="/ingest"
            className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30]"
          >
            Ingest Data Baru
          </Link>
        </div>
      </div>

      {/* Usage Tray */}
      <section className="bg-[var(--ground)] border border-[var(--border)] rounded-lg p-1.5 flex flex-col gap-1.5">
        <div
          className="grid grid-cols-2 lg:grid-cols-5 bg-white border border-[var(--border)] rounded-md overflow-hidden"
          role="group"
          aria-label="Pilih metrik grafik"
        >
          {kpis.map((k, idx) => {
            const selected = activeKpi === k.id;
            return (
              <button
                key={k.id}
                type="button"
                onClick={() => setActiveKpi(k.id)}
                aria-pressed={selected}
                className={`text-left px-4 py-3.5 flex flex-col gap-1 border-b-2 transition-colors cursor-pointer ${
                  idx < kpis.length - 1 ? "lg:border-r border-r-[var(--rule)]" : ""
                } ${
                  selected
                    ? "border-b-[var(--accent)] bg-[#fafcfb]"
                    : "border-b-transparent hover:bg-[var(--raised)]"
                } ${idx === kpis.length - 1 ? "col-span-2 lg:col-span-1" : ""}`}
              >
                <span className="text-[13px] font-medium text-[var(--muted)]">
                  {k.label}
                </span>
                <span className="text-[24px] leading-7 font-normal tabular-nums text-[var(--text)]">
                  {k.value}
                </span>
                <span
                  className={`text-[13px] ${
                    k.tone === "pos"
                      ? "text-[var(--positive)]"
                      : k.tone === "neg"
                      ? "text-[var(--negative)]"
                      : "text-[var(--faint)]"
                  }`}
                >
                  {k.delta}
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-1.5">
          <div className="lg:col-span-8 bg-white border border-[var(--border)] rounded-lg p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
              <h2 className="text-[14px] font-medium text-[var(--text)]">
                {chartConfig.title}
              </h2>
              {chartConfig.series.length > 1 && (
                <div className="flex items-center gap-4 text-[12px] text-[var(--muted)]">
                  {chartConfig.series.map((s) => (
                    <span key={s.name} className="inline-flex items-center gap-1.5">
                      <span
                        className="w-3 h-0.5 inline-block"
                        style={{ backgroundColor: s.color }}
                      />
                      {s.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <SimpleLineChart
              labels={currentSnapshot.monthlyLabels}
              series={chartConfig.series}
              unitSuffix={chartConfig.unit}
            />
          </div>

          <div className="lg:col-span-4 bg-white border border-[var(--border)] rounded-lg p-5 flex flex-col">
            <div className="flex items-center justify-between gap-2 mb-4">
              <h2 className="text-[16px] font-semibold text-[var(--text)]">
                Pipeline Medallion Iceberg
              </h2>
              <span className="font-mono-code text-[12px] text-[var(--faint)]">
                {currentSnapshot.id}
              </span>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="border border-[var(--border)] rounded-md px-3.5 py-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium px-2 py-0.5 rounded bg-[#fdf3e7] text-[#8a4b08]">
                    Bronze · Raw
                  </span>
                  <span className="font-mono-code text-[13px]">2 tabel</span>
                </div>
                <div className="flex justify-between text-[13px] text-[var(--muted)] tabular-nums">
                  <span>32.518 baris mentah</span>
                  <span>5,0 MB</span>
                </div>
              </div>

              <div className="border border-[var(--border)] rounded-md px-3.5 py-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium px-2 py-0.5 rounded bg-[#edf0f2] text-[#364149]">
                    Silver · Clean
                  </span>
                  <span className="font-mono-code text-[13px]">2 tabel</span>
                </div>
                <div className="flex justify-between text-[13px] text-[var(--muted)] tabular-nums">
                  <span>32.518 baris tervalidasi</span>
                  <span>3,4 MB</span>
                </div>
              </div>

              <div className="border border-[var(--border)] rounded-md px-3.5 py-3 flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium px-2 py-0.5 rounded bg-[#e3f2ed] text-[#125142]">
                    Gold · Serving
                  </span>
                  <span className="font-mono-code text-[13px]">2 tabel</span>
                </div>
                <div className="flex justify-between text-[13px] text-[var(--muted)] tabular-nums">
                  <span>
                    {totals.opdCount} OPD · {totals.subKegiatanCount} sub-kegiatan
                  </span>
                  <span>0,6 MB</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* OPD Absorption Table */}
      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-[16px] font-semibold">Serapan Anggaran per OPD</h2>
            <p className="text-[12px] text-[var(--faint)] mt-0.5">
              Sumber:{" "}
              <span className="font-mono-code">gold.apbd_opd_summary</span> · Commit{" "}
              {currentSnapshot.committedAt}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center gap-0.5 text-[14px] font-medium text-[var(--text)] hover:underline cursor-pointer"
          >
            <span>
              {showAll ? "Ringkas (6 OPD)" : `Lihat semua ${filteredOpd.length} OPD`}
            </span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                <th className="text-left font-medium pb-2.5 pr-3">Kode</th>
                <th className="text-left font-medium pb-2.5 pr-3">
                  Perangkat Daerah (OPD)
                </th>
                <th className="text-right font-medium pb-2.5 pr-3">Pagu</th>
                <th className="text-right font-medium pb-2.5 pr-3">Realisasi</th>
                <th className="text-right font-medium pb-2.5 pr-3">Serapan</th>
                <th className="text-right font-medium pb-2.5 pr-3">Anomali</th>
                <th className="text-left font-medium pb-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleOpd.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-[13px] text-[var(--faint)]">
                    Tidak ada OPD yang cocok dengan pencarian &ldquo;{searchQuery}&rdquo;.
                  </td>
                </tr>
              ) : (
                visibleOpd.map((o) => {
                  const isLag =
                    currentSnapshot.id === "snap_94a8f10c" && o.serapan < 65;
                  return (
                    <tr
                      key={o.kode}
                      className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                    >
                      <td className="font-mono-code text-[13px] py-3 pr-3">
                        {o.kode}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium text-[var(--text)]">{o.nama}</div>
                        <div className="text-[13px] text-[var(--faint)]">
                          {o.urusan} · {o.subKegiatan} sub-kegiatan
                        </div>
                      </td>
                      <td className="text-right tabular-nums py-3 pr-3">
                        {fmtRpM(o.paguM)}
                      </td>
                      <td className="text-right tabular-nums py-3 pr-3">
                        {fmtRpM(o.realisasiM)}
                      </td>
                      <td className="text-right tabular-nums py-3 pr-3 whitespace-nowrap">
                        <span>{fmtPct(o.serapan)}</span>
                        <span
                          className="inline-block w-20 h-1 bg-[var(--rule)] rounded-sm overflow-hidden align-middle ml-2"
                          aria-hidden="true"
                        >
                          <span
                            className={`block h-full ${
                              isLag ? "bg-[var(--negative)]" : "bg-[var(--accent)]"
                            }`}
                            style={{ width: `${Math.min(100, o.serapan)}%` }}
                          />
                        </span>
                      </td>
                      <td className="text-right tabular-nums py-3 pr-3">
                        {o.anomali === 0 ? (
                          <span className="text-[var(--faint)]">0</span>
                        ) : (
                          o.anomali
                        )}
                      </td>
                      <td className="py-3">
                        {isLag ? (
                          <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]">
                            Tertinggal
                          </span>
                        ) : o.anomali > 0 ? (
                          <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]">
                            Cek Data
                          </span>
                        ) : (
                          <span className="inline-flex items-center h-5.5 px-2 rounded text-[12px] font-medium bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]">
                            Sesuai Target
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
