"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  LayoutGrid,
  Table as TableIcon,
  UploadCloud,
} from "lucide-react";
import { useLakehouse } from "@/components/LakehouseContext";
import { fmtPct, fmtRp, type OpdSummaryRow } from "@/lib/api";

type HealthFilter = "all" | "low" | "mid" | "high";

function classifyHealth(o: OpdSummaryRow): "low" | "mid" | "high" {
  if (o.serapan_sp2d_pct >= 70) return "high";
  if (o.serapan_sp2d_pct >= 50) return "mid";
  return "low";
}

function AbsorptionRing({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 52;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);

  return (
    <svg
      width="132"
      height="132"
      viewBox="0 0 132 132"
      role="img"
      aria-label={`Serapan APBD ${fmtPct(clamped)}`}
      className="shrink-0"
    >
      <circle
        cx="66"
        cy="66"
        r={r}
        fill="none"
        stroke="var(--rule)"
        strokeWidth="12"
      />
      <circle
        cx="66"
        cy="66"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="12"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 66 66)"
      />
      <text
        x="66"
        y="63"
        textAnchor="middle"
        className="fill-[var(--text)] text-[22px] font-semibold tabular-nums"
      >
        {fmtPct(clamped)}
      </text>
      <text
        x="66"
        y="81"
        textAnchor="middle"
        className="fill-[var(--faint)] text-[11px]"
      >
        Sudah cair
      </text>
    </svg>
  );
}

export default function OverviewPage() {
  const { overview, loading, error, searchQuery } = useLakehouse();
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const sisaRp = Math.max(0, overview.totals.alokasiRp - overview.totals.sp2dRp);

  const healthCounts = useMemo(() => {
    let low = 0;
    let mid = 0;
    let high = 0;
    overview.opd.forEach((o) => {
      const h = classifyHealth(o);
      if (h === "high") high += 1;
      else if (h === "mid") mid += 1;
      else low += 1;
    });
    return { low, mid, high };
  }, [overview.opd]);

  const topBudgetOpd = useMemo(
    () => [...overview.opd].sort((a, b) => b.alokasi_rp - a.alokasi_rp).slice(0, 8),
    [overview.opd]
  );
  const maxAlokasi = topBudgetOpd[0]?.alokasi_rp || 1;

  const lowestSerapan = useMemo(
    () =>
      [...overview.opd]
        .filter((o) => o.alokasi_rp > 0)
        .sort((a, b) => a.serapan_sp2d_pct - b.serapan_sp2d_pct)
        .slice(0, 5),
    [overview.opd]
  );

  const highestSerapan = useMemo(
    () =>
      [...overview.opd]
        .filter((o) => o.alokasi_rp > 0)
        .sort((a, b) => b.serapan_sp2d_pct - a.serapan_sp2d_pct)
        .slice(0, 5),
    [overview.opd]
  );

  const maxTematik = useMemo(
    () => Math.max(1, ...overview.tematik.map((t) => t.total_rp)),
    [overview.tematik]
  );

  const filteredOpd = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return overview.opd.filter((o) => {
      const qOk = !q || o.nama_opd.toLowerCase().includes(q);
      const hOk = healthFilter === "all" || classifyHealth(o) === healthFilter;
      return qOk && hOk;
    });
  }, [overview.opd, searchQuery, healthFilter]);

  const visibleOpd = showAll ? filteredOpd : filteredOpd.slice(0, 12);

  return (
    <>
      {/* Header with plain-language summary */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            Ikhtisar APBD Surabaya
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            {error ? (
              <span className="text-[var(--negative)]">{error}</span>
            ) : overview.isEmpty ? (
              "Belum ada data di Lakehouse. Unggah berkas Excel/CSV/PDF atau ambil dari website untuk mulai melihat visualisasi."
            ) : (
              <>
                Dari total anggaran{" "}
                <strong className="font-medium text-[var(--text)]">
                  {fmtRp(overview.totals.alokasiRp)}
                </strong>{" "}
                di{" "}
                <strong className="font-medium text-[var(--text)]">
                  {overview.totals.opdCount} dinas &amp; badan
                </strong>
                , sudah cair{" "}
                <strong className="font-medium text-[var(--text)]">
                  {fmtRp(overview.totals.sp2dRp)} ({fmtPct(overview.totals.serapanPct)})
                </strong>{" "}
                dan masih tersisa{" "}
                <strong className="font-medium text-[var(--text)]">{fmtRp(sisaRp)}</strong>.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/catalog"
            className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)]"
          >
            Katalog &amp; CRUD
          </Link>
          <Link
            href="/ingest"
            className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30]"
          >
            Ingest Data
          </Link>
        </div>
      </div>

      {overview.isEmpty ? (
        <section className="bg-white border border-dashed border-[var(--control)] rounded-lg p-8 flex flex-col items-start gap-3">
          <div className="flex items-center gap-2 text-[var(--text)] font-semibold text-[16px]">
            <UploadCloud className="w-5 h-5 text-[var(--accent)]" />
            <span>Belum ada data APBD yang masuk</span>
          </div>
          <p className="text-[14px] text-[var(--muted)] max-w-[640px]">
            Unggah file Excel Monitoring Semua PD, Tabel eBudgeting, CSV, PDF, atau masukkan URL{" "}
            <span className="font-mono-code text-[13px]">surabaya.go.id</span>. Grafik dan ringkasan visual akan langsung muncul otomatis.
          </p>
          <Link
            href="/ingest"
            className="inline-flex items-center h-9 px-4 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30]"
          >
            Mulai Unggah Data
          </Link>
        </section>
      ) : (
        <>
          {/* HERO VISUAL ROW: Left = Absorption Ring & Health Split, Right = Top 8 Biggest Budgets */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            {/* Left: Ring & Plain-language breakdown */}
            <section className="lg:col-span-5 bg-white border border-[var(--border)] rounded-lg p-5 flex flex-col justify-between gap-5">
              <div>
                <h2 className="text-[16px] font-semibold">Seberapa Cepat APBD Terserap?</h2>
                <p className="text-[13px] text-[var(--muted)] mt-0.5">
                  Perbandingan dana yang sudah dicairkan (SP2D) terhadap total anggaran kota.
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-5">
                <AbsorptionRing pct={loading ? 0 : overview.totals.serapanPct} />
                <div className="flex-1 w-full flex flex-col gap-2.5 text-[14px]">
                  <div className="flex items-center justify-between border-b border-[var(--rule)] pb-2">
                    <span className="text-[var(--muted)]">Total Anggaran</span>
                    <span className="font-semibold tabular-nums">
                      {loading ? "—" : fmtRp(overview.totals.alokasiRp)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-b border-[var(--rule)] pb-2">
                    <span className="flex items-center gap-2 text-[var(--muted)]">
                      <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent)]" />
                      Sudah Cair
                    </span>
                    <span className="font-semibold tabular-nums text-[var(--accent)]">
                      {loading ? "—" : fmtRp(overview.totals.sp2dRp)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-[var(--muted)]">
                      <span className="w-2.5 h-2.5 rounded-full bg-[var(--rule)] border border-[var(--control)]" />
                      Sisa Anggaran
                    </span>
                    <span className="font-medium tabular-nums text-[var(--muted)]">
                      {loading ? "—" : fmtRp(sisaRp)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Health distribution bar */}
              <div className="pt-3 border-t border-[var(--rule)]">
                <div className="flex items-center justify-between text-[13px] mb-2">
                  <span className="font-medium text-[var(--text)]">
                    Kondisi {overview.totals.opdCount} Dinas / Badan
                  </span>
                  <span className="text-[12px] text-[var(--faint)]">Klik untuk filter</span>
                </div>
                <div className="w-full h-2.5 rounded-full overflow-hidden flex bg-[var(--rule)]">
                  <button
                    type="button"
                    title={`Optimal (>=70%): ${healthCounts.high} dinas`}
                    onClick={() => setHealthFilter(healthFilter === "high" ? "all" : "high")}
                    style={{
                      width: `${(healthCounts.high / Math.max(1, overview.totals.opdCount)) * 100}%`,
                    }}
                    className="bg-[var(--accent)] h-full cursor-pointer"
                  />
                  <button
                    type="button"
                    title={`Cukup (50-69%): ${healthCounts.mid} dinas`}
                    onClick={() => setHealthFilter(healthFilter === "mid" ? "all" : "mid")}
                    style={{
                      width: `${(healthCounts.mid / Math.max(1, overview.totals.opdCount)) * 100}%`,
                    }}
                    className="bg-[#94b8ad] h-full cursor-pointer"
                  />
                  <button
                    type="button"
                    title={`Perlu Perhatian (<50%): ${healthCounts.low} dinas`}
                    onClick={() => setHealthFilter(healthFilter === "low" ? "all" : "low")}
                    style={{
                      width: `${(healthCounts.low / Math.max(1, overview.totals.opdCount)) * 100}%`,
                    }}
                    className="bg-[var(--negative)] h-full cursor-pointer"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2.5 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setHealthFilter(healthFilter === "high" ? "all" : "high")}
                    className="text-left cursor-pointer hover:underline"
                  >
                    <span className="font-semibold text-[var(--text)] tabular-nums">
                      {healthCounts.high} dinas
                    </span>
                    <div className="text-[var(--faint)]">Optimal (≥70%)</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHealthFilter(healthFilter === "mid" ? "all" : "mid")}
                    className="text-left cursor-pointer hover:underline"
                  >
                    <span className="font-semibold text-[var(--text)] tabular-nums">
                      {healthCounts.mid} dinas
                    </span>
                    <div className="text-[var(--faint)]">Cukup (50–69%)</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setHealthFilter(healthFilter === "low" ? "all" : "low")}
                    className="text-left cursor-pointer hover:underline"
                  >
                    <span className="font-semibold text-[var(--negative)] tabular-nums">
                      {healthCounts.low} dinas
                    </span>
                    <div className="text-[var(--faint)]">Rendah (&lt;50%)</div>
                  </button>
                </div>
              </div>
            </section>

            {/* Right: Top 8 Biggest Budget Visual Bars */}
            <section className="lg:col-span-7 bg-white border border-[var(--border)] rounded-lg p-5 flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-semibold">
                    Ke Mana Uang Terbesar Dialokasikan?
                  </h2>
                  <p className="text-[13px] text-[var(--muted)] mt-0.5">
                    8 dinas dengan anggaran terbesar. Batang abu = total pagu, batang berwarna = sudah cair.
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-3 text-[12px] text-[var(--muted)] shrink-0">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[var(--accent)]" />
                    Cair ≥50%
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-[var(--negative)]" />
                    Cair &lt;50%
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {topBudgetOpd.map((o) => {
                  const totalWidthPct = Math.max(4, (o.alokasi_rp / maxAlokasi) * 100);
                  const spentWithinBarPct = Math.min(100, o.serapan_sp2d_pct);
                  const isLow = o.serapan_sp2d_pct < 50;
                  return (
                    <div key={o.nama_opd} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="font-medium text-[var(--text)] truncate">
                          {o.nama_opd}
                        </span>
                        <span className="tabular-nums text-[var(--muted)] shrink-0">
                          <strong className="font-medium text-[var(--text)]">
                            {fmtRp(o.sp2d_rp)}
                          </strong>{" "}
                          / {fmtRp(o.alokasi_rp)}{" "}
                          <span
                            className={
                              isLow ? "text-[var(--negative)] font-medium" : "text-[var(--accent)] font-medium"
                            }
                          >
                            ({fmtPct(o.serapan_sp2d_pct)})
                          </span>
                        </span>
                      </div>
                      <div className="w-full h-3 bg-[var(--ground)] rounded overflow-hidden">
                        <div
                          className="h-full bg-[#dfe4e1] rounded overflow-hidden"
                          style={{ width: `${totalWidthPct}%` }}
                        >
                          <div
                            className={`h-full ${isLow ? "bg-[var(--negative)]" : "bg-[var(--accent)]"}`}
                            style={{ width: `${spentWithinBarPct}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          {/* SPOTLIGHT ROW: Needs Attention vs Top Performers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-[var(--border)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-[var(--negative)]" />
                <h2 className="text-[16px] font-semibold">Perlu Perhatian (Serapan Terendah)</h2>
              </div>
              <p className="text-[13px] text-[var(--muted)] mb-4">
                5 dinas dengan persentase pencairan paling lambat saat ini.
              </p>
              <div className="flex flex-col gap-3">
                {lowestSerapan.map((o) => {
                  const isRsud = o.nama_opd.toUpperCase().includes("RSUD");
                  return (
                    <div
                      key={o.nama_opd}
                      className="border border-[var(--rule)] rounded-md p-3 flex flex-col gap-1.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[14px] font-medium text-[var(--text)] truncate">
                          {o.nama_opd}
                          {isRsud && (
                            <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)] font-normal">
                              BLUD
                            </span>
                          )}
                        </span>
                        <span className="text-[14px] font-semibold tabular-nums text-[var(--negative)] shrink-0">
                          {fmtPct(o.serapan_sp2d_pct)}
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--rule)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--negative)]"
                          style={{ width: `${Math.min(100, o.serapan_sp2d_pct)}%` }}
                        />
                      </div>
                      <div className="text-[12px] text-[var(--muted)] tabular-nums">
                        Baru cair {fmtRp(o.sp2d_rp)} dari anggaran {fmtRp(o.alokasi_rp)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="bg-white border border-[var(--border)] rounded-lg p-5">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-4 h-4 text-[var(--accent)]" />
                <h2 className="text-[16px] font-semibold">Paling Cepat Menyerap Anggaran</h2>
              </div>
              <p className="text-[13px] text-[var(--muted)] mb-4">
                5 dinas dengan persentase pencairan tertinggi hingga periode ini.
              </p>
              <div className="flex flex-col gap-3">
                {highestSerapan.map((o) => (
                  <div
                    key={o.nama_opd}
                    className="border border-[var(--rule)] rounded-md p-3 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14px] font-medium text-[var(--text)] truncate">
                        {o.nama_opd}
                      </span>
                      <span className="text-[14px] font-semibold tabular-nums text-[var(--accent)] shrink-0">
                        {fmtPct(o.serapan_sp2d_pct)}
                      </span>
                    </div>
                    <div className="w-full h-1.5 bg-[var(--rule)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent)]"
                        style={{ width: `${Math.min(100, o.serapan_sp2d_pct)}%` }}
                      />
                    </div>
                    <div className="text-[12px] text-[var(--muted)] tabular-nums">
                      Sudah cair {fmtRp(o.sp2d_rp)} dari anggaran {fmtRp(o.alokasi_rp)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* TEMATIK PRIORITAS VISUAL BARS */}
          {overview.tematik.length > 0 && (
            <section className="bg-white border border-[var(--border)] rounded-lg p-5">
              <div className="mb-4">
                <h2 className="text-[16px] font-semibold">Fokus Anggaran Prioritas (eBudgeting PAK)</h2>
                <p className="text-[13px] text-[var(--muted)] mt-0.5">
                  Sebaran alokasi untuk program prioritas warga seperti pendidikan, penanganan kemiskinan, dan stunting.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                {overview.tematik
                  .filter((t) => t.total_rp > 0)
                  .sort((a, b) => b.total_rp - a.total_rp)
                  .map((t) => (
                    <div key={t.tema} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between text-[13px]">
                        <span className="font-medium text-[var(--text)]">{t.tema}</span>
                        <span className="tabular-nums text-[var(--muted)]">
                          <strong className="font-medium text-[var(--text)]">
                            {fmtRp(t.total_rp)}
                          </strong>{" "}
                          · {t.komponen.toLocaleString("id-ID")} komponen
                        </span>
                      </div>
                      <div className="w-full h-2.5 bg-[var(--ground)] rounded overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded"
                          style={{ width: `${Math.max(3, (t.total_rp / maxTematik) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* ALL OPDS: Visual Cards (default) or Detail Table */}
          <section className="bg-white border border-[var(--border)] rounded-lg p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-[16px] font-semibold">
                  Semua Dinas &amp; Badan ({filteredOpd.length})
                </h2>
                <p className="text-[13px] text-[var(--muted)] mt-0.5">
                  Pilih tampilan kartu visual yang mudah dibaca, atau tabel detail untuk analisis angka.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* View mode switcher */}
                <div className="inline-flex rounded-md border border-[var(--control)] p-0.5 bg-[var(--ground)]">
                  <button
                    type="button"
                    onClick={() => setViewMode("cards")}
                    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[12px] font-medium cursor-pointer ${
                      viewMode === "cards"
                        ? "bg-white text-[var(--text)] border border-[var(--border)]"
                        : "text-[var(--muted)]"
                    }`}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    Kartu Visual
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("table")}
                    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[12px] font-medium cursor-pointer ${
                      viewMode === "table"
                        ? "bg-white text-[var(--text)] border border-[var(--border)]"
                        : "text-[var(--muted)]"
                    }`}
                  >
                    <TableIcon className="w-3.5 h-3.5" />
                    Tabel Detail
                  </button>
                </div>
              </div>
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {(
                [
                  { id: "all", label: `Semua (${overview.opd.length})` },
                  { id: "low", label: `Perlu Perhatian <50% (${healthCounts.low})` },
                  { id: "mid", label: `Cukup 50–69% (${healthCounts.mid})` },
                  { id: "high", label: `Optimal ≥70% (${healthCounts.high})` },
                ] as const
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setHealthFilter(f.id);
                    setShowAll(false);
                  }}
                  className={`h-7 px-3 rounded-md text-[12px] font-medium border cursor-pointer transition-colors ${
                    healthFilter === f.id
                      ? "border-[var(--accent)] bg-[#f2f8f6] text-[var(--text)]"
                      : "border-[var(--border)] bg-white text-[var(--muted)] hover:text-[var(--text)]"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {filteredOpd.length === 0 ? (
              <p className="text-[13px] text-[var(--faint)] py-4">
                Tidak ada dinas yang cocok dengan filter atau pencarian &ldquo;{searchQuery}&rdquo;.
              </p>
            ) : viewMode === "cards" ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5">
                {visibleOpd.map((o) => {
                  const health = classifyHealth(o);
                  const isLow = health === "low";
                  return (
                    <div
                      key={o.nama_opd}
                      className="border border-[var(--border)] rounded-lg p-4 flex flex-col gap-2.5 hover:bg-[var(--ground)] transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium text-[14px] text-[var(--text)] leading-snug">
                          {o.nama_opd}
                        </div>
                        <span
                          className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded ${
                            isLow
                              ? "bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]"
                              : health === "high"
                                ? "bg-[var(--pill-positive-bg)] text-[var(--pill-positive-ink)]"
                                : "bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]"
                          }`}
                        >
                          {isLow ? "Rendah" : health === "high" ? "Optimal" : "Cukup"}
                        </span>
                      </div>

                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[20px] font-semibold tabular-nums text-[var(--text)]">
                          {fmtPct(o.serapan_sp2d_pct)}
                        </span>
                        <span className="text-[12px] text-[var(--muted)] tabular-nums">
                          {fmtRp(o.sp2d_rp)} / {fmtRp(o.alokasi_rp)}
                        </span>
                      </div>

                      <div className="w-full h-2 bg-[var(--rule)] rounded-full overflow-hidden">
                        <div
                          className={`h-full ${isLow ? "bg-[var(--negative)]" : "bg-[var(--accent)]"}`}
                          style={{ width: `${Math.min(100, o.serapan_sp2d_pct)}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[12px] text-[var(--faint)] tabular-nums pt-1">
                        <span>{o.jumlah_sub_kegiatan} sub-kegiatan</span>
                        <span>
                          {o.jumlah_anomali > 0
                            ? `${o.jumlah_anomali.toLocaleString("id-ID")} catatan audit`
                            : "Data bersih"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[14px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                      <th className="text-left font-medium pb-2.5 pr-3">Perangkat Daerah</th>
                      <th className="text-right font-medium pb-2.5 pr-3">Anggaran</th>
                      <th className="text-right font-medium pb-2.5 pr-3">Sudah Cair</th>
                      <th className="text-right font-medium pb-2.5 pr-3">Serapan</th>
                      <th className="text-right font-medium pb-2.5">Catatan Audit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOpd.map((o) => {
                      const isLow = o.serapan_sp2d_pct < 50;
                      return (
                        <tr
                          key={o.nama_opd}
                          className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                        >
                          <td className="py-3 pr-3 font-medium text-[var(--text)]">
                            {o.nama_opd}
                          </td>
                          <td className="text-right tabular-nums py-3 pr-3">
                            {fmtRp(o.alokasi_rp)}
                          </td>
                          <td className="text-right tabular-nums py-3 pr-3">
                            {fmtRp(o.sp2d_rp)}
                          </td>
                          <td className="text-right tabular-nums py-3 pr-3 whitespace-nowrap">
                            <span className={isLow ? "text-[var(--negative)] font-medium" : ""}>
                              {fmtPct(o.serapan_sp2d_pct)}
                            </span>
                          </td>
                          <td className="text-right tabular-nums py-3 text-[var(--muted)]">
                            {o.jumlah_anomali.toLocaleString("id-ID")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {filteredOpd.length > 12 && (
              <div className="mt-4 pt-3 border-t border-[var(--rule)] flex justify-center">
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--text)] hover:underline cursor-pointer"
                >
                  <span>
                    {showAll
                      ? "Tampilkan lebih ringkas (12 dinas)"
                      : `Tampilkan semua ${filteredOpd.length} dinas`}
                  </span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </section>

          {/* PLAIN-LANGUAGE LAKEHOUSE PIPELINE EXPLAINER */}
          <section className="bg-[var(--ground)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-[14px] font-semibold">Alur Pengolahan Data (Lakehouse)</h2>
                <p className="text-[12px] text-[var(--muted)]">
                  Bagaimana file mentah berubah menjadi tampilan di atas secara otomatis.
                </p>
              </div>
              <Link
                href="/catalog"
                className="text-[12px] font-medium text-[var(--accent)] hover:underline"
              >
                Kelola di Katalog →
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
              {(
                [
                  {
                    key: "bronze",
                    step: "1. Data Mentah (Bronze)",
                    desc: "File asli disimpan apa adanya sebagai arsip.",
                    badge: "bg-[#fdf3e7] text-[#8a4b08]",
                  },
                  {
                    key: "silver",
                    step: "2. Data Bersih (Silver)",
                    desc: "Angka dirapikan & kejanggalan ditandai.",
                    badge: "bg-[#edf0f2] text-[#364149]",
                  },
                  {
                    key: "gold",
                    step: "3. Siap Baca (Gold)",
                    desc: "Dirangkum jadi grafik & kartu dinas di atas.",
                    badge: "bg-[#e3f2ed] text-[#125142]",
                  },
                ] as const
              ).map((item, idx) => {
                const info = overview.layers[item.key];
                return (
                  <div
                    key={item.key}
                    className="bg-white border border-[var(--border)] rounded-md p-3.5 flex flex-col gap-1.5 relative"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[12px] font-medium px-2 py-0.5 rounded ${item.badge}`}>
                        {item.step}
                      </span>
                      {idx < 2 && (
                        <ArrowRight className="hidden md:block w-4 h-4 text-[var(--faint)]" />
                      )}
                    </div>
                    <p className="text-[12px] text-[var(--muted)]">{item.desc}</p>
                    <div className="text-[12px] text-[var(--faint)] tabular-nums pt-1 border-t border-[var(--rule)] flex justify-between">
                      <span>{info.tables} tabel</span>
                      <span>{info.rows.toLocaleString("id-ID")} baris</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </>
  );
}
