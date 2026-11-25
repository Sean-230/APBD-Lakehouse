"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useLakehouse } from "@/components/LakehouseContext";
import {
  CATALOG_TABLES,
  computeSnapshotTotals,
  fmtRpM,
  type MedallionLayer,
} from "@/lib/lakehouse-data";

export default function CatalogPage() {
  const { snapshots, snapshotIdx, setSnapshotIdx, searchQuery } = useLakehouse();
  const [layer, setLayer] = useState<"all" | MedallionLayer>("all");
  const [selectedName, setSelectedName] = useState("gold.apbd_opd_summary");

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return CATALOG_TABLES.filter((t) => {
      const layerOk = layer === "all" || t.layer === layer;
      const qOk =
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q);
      return layerOk && qOk;
    });
  }, [layer, searchQuery]);

  const selected =
    CATALOG_TABLES.find((t) => t.name === selectedName) ??
    filtered[0] ??
    CATALOG_TABLES[0];

  const layerBadge = (l: MedallionLayer) => {
    if (l === "bronze") return "bg-[#fdf3e7] text-[#8a4b08]";
    if (l === "silver") return "bg-[#edf0f2] text-[#364149]";
    return "bg-[#e3f2ed] text-[#125142]";
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            Katalog Apache Iceberg
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            <strong className="font-medium text-[var(--text)]">
              {CATALOG_TABLES.length} tabel terdaftar
            </strong>{" "}
            dalam format Parquet + Metadata Iceberg v2 (SQLite Catalog dev / MinIO prod).
          </p>
        </div>
        <Link
          href="/sql"
          className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] shrink-0"
        >
          Query di SQL Explorer
        </Link>
      </div>

      {/* 2px underline tabs */}
      <div
        className="flex items-center gap-5 border-b border-[var(--border)]"
        role="tablist"
      >
        {(
          [
            { id: "all", label: `Semua (${CATALOG_TABLES.length})` },
            { id: "bronze", label: "Bronze (Raw)" },
            { id: "silver", label: "Silver (Clean)" },
            { id: "gold", label: "Gold (Serving)" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={layer === tab.id}
            onClick={() => setLayer(tab.id)}
            className={`pb-2.5 pt-2 -mb-px text-[14px] font-medium border-b-2 transition-colors cursor-pointer ${
              layer === tab.id
                ? "border-[var(--accent)] text-[var(--text)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white border border-[var(--border)] rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[16px] font-semibold">Daftar Tabel Warehouse</h2>
            <span className="text-[12px] text-[var(--faint)]">
              Klik baris untuk lihat skema
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                  <th className="text-left font-medium pb-2.5 pr-3">Nama Tabel</th>
                  <th className="text-left font-medium pb-2.5 pr-3">Layer</th>
                  <th className="text-right font-medium pb-2.5 pr-3">Baris</th>
                  <th className="text-right font-medium pb-2.5 pr-3">Ukuran</th>
                  <th className="text-left font-medium pb-2.5">Snapshot</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.name}
                    onClick={() => setSelectedName(t.name)}
                    className={`border-b border-[var(--rule)] last:border-b-0 cursor-pointer hover:bg-[var(--raised)] ${
                      t.name === selected.name ? "bg-[var(--raised)]" : ""
                    }`}
                  >
                    <td className="py-3 pr-3">
                      <div className="font-mono-code text-[13px] font-medium text-[var(--text)]">
                        {t.name}
                      </div>
                      <div className="text-[12px] text-[var(--faint)]">
                        Partisi: <span className="font-mono-code">{t.partition}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <span
                        className={`text-[12px] font-medium px-2 py-0.5 rounded capitalize ${layerBadge(
                          t.layer
                        )}`}
                      >
                        {t.layer}
                      </span>
                    </td>
                    <td className="text-right tabular-nums py-3 pr-3">
                      {t.rows.toLocaleString("id-ID")}
                    </td>
                    <td className="text-right tabular-nums py-3 pr-3">
                      {t.sizeMb.toFixed(1).replace(".", ",")} MB
                    </td>
                    <td className="font-mono-code text-[13px] py-3">
                      {t.snapshotId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lg:col-span-5 bg-white border border-[var(--border)] rounded-lg p-5">
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <h2 className="font-mono-code text-[15px] font-semibold">
                {selected.name}
              </h2>
              <p className="text-[12px] text-[var(--faint)]">
                {selected.format} · {selected.files} file Parquet
              </p>
            </div>
            <span
              className={`text-[12px] font-medium px-2 py-0.5 rounded uppercase ${layerBadge(
                selected.layer
              )}`}
            >
              {selected.layer}
            </span>
          </div>
          <p className="text-[13px] text-[var(--muted)] mb-3">
            {selected.description}
          </p>
          <div className="text-[12px] text-[var(--faint)] mb-4">
            Upstream:{" "}
            <span className="font-mono-code text-[var(--text)]">
              {selected.upstream.join(", ")}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[12px] text-[var(--faint)]">
                  <th className="text-left font-medium pb-2 pr-2">Kolom</th>
                  <th className="text-left font-medium pb-2 pr-2">Tipe</th>
                  <th className="text-left font-medium pb-2">Contoh</th>
                </tr>
              </thead>
              <tbody>
                {selected.columns.map((c) => (
                  <tr
                    key={c.name}
                    className="border-b border-[var(--rule)] last:border-b-0"
                  >
                    <td className="font-mono-code py-2 pr-2">{c.name}</td>
                    <td className="font-mono-code text-[var(--faint)] py-2 pr-2">
                      {c.type}
                    </td>
                    <td className="text-[var(--muted)] py-2">{c.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Snapshot Time-Travel History */}
      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="mb-4">
          <h2 className="text-[16px] font-semibold">
            Riwayat Snapshot &amp; Time-Travel Iceberg
          </h2>
          <p className="text-[12px] text-[var(--faint)] mt-0.5">
            Setiap pembaruan APBD (Murni → Pergeseran → PAK) tersimpan immutable
            sebagai snapshot terpisah.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[13px] text-[var(--faint)]">
                <th className="text-left font-medium pb-2.5 pr-3">Snapshot ID</th>
                <th className="text-left font-medium pb-2.5 pr-3">Versi APBD</th>
                <th className="text-left font-medium pb-2.5 pr-3">Sumber</th>
                <th className="text-right font-medium pb-2.5 pr-3">Parquet</th>
                <th className="text-right font-medium pb-2.5 pr-3">Total Pagu</th>
                <th className="text-right font-medium pb-2.5 pr-3">Commit</th>
                <th className="text-left font-medium pb-2.5">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s, idx) => {
                const t = computeSnapshotTotals(s);
                return (
                  <tr
                    key={s.id}
                    className="border-b border-[var(--rule)] last:border-b-0"
                  >
                    <td className="font-mono-code text-[13px] py-3 pr-3">
                      {s.id}
                    </td>
                    <td className="py-3 pr-3">
                      <div className="font-medium">{s.label}</div>
                      <div className="text-[13px] text-[var(--faint)]">
                        {s.summary}
                      </div>
                    </td>
                    <td className="py-3 pr-3 text-[13px]">{s.source}</td>
                    <td className="text-right tabular-nums py-3 pr-3">
                      {s.parquetFiles}
                    </td>
                    <td className="text-right tabular-nums py-3 pr-3">
                      {fmtRpM(t.paguM)}
                    </td>
                    <td className="text-right tabular-nums py-3 pr-3 text-[13px]">
                      {s.committedAt}
                    </td>
                    <td className="py-3">
                      {idx === snapshotIdx ? (
                        <span className="inline-flex items-center h-6 px-2 rounded text-[12px] font-medium bg-[var(--pill-positive-bg)] text-[var(--pill-positive-ink)]">
                          Aktif
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSnapshotIdx(idx)}
                          className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)] cursor-pointer"
                        >
                          Time-Travel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
