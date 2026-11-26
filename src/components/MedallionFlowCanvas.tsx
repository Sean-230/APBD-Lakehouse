"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import {
  fetchVectorStats,
  indexVectors,
  searchVectorsApi,
  type CatalogTable,
  type VectorSearchResponse,
  type VectorStatsResponse,
} from "@/lib/api";

interface MedallionFlowCanvasProps {
  tables: CatalogTable[];
  selectedName: string;
  busyAction: boolean;
  onSelectTable: (name: string) => void;
  onPromoteBronze: (tableName: string) => Promise<void>;
  onPromoteSilver: (tableName: string) => Promise<void>;
  onVectorUpdated: (message: string) => void;
}

interface FlowStepState {
  active: boolean;
  label: string;
  stages: { title: string; state: "done" | "active" | "idle" }[];
}

/** Determine visual downstream/upstream relationships between Bronze, Silver, and Gold tables. */
function getRelatedSet(tableName: string, allTables: CatalogTable[]): Set<string> {
  const rel = new Set<string>();
  if (!tableName) return rel;
  rel.add(tableName);

  const names = new Set(allTables.map((t) => t.name));

  // Known APBD lineage chains
  const chains: string[][] = [
    [
      "bronze.monitoring_pd_raw",
      "silver.monitoring_pekerjaan",
      "gold.apbd_opd_summary",
      "gold.dq_anomaly_audit",
    ],
    [
      "bronze.ebudgeting_rincian_raw",
      "silver.ebudgeting_rincian",
      "gold.ebudgeting_curated",
      "gold.apbd_subkegiatan_summary",
      "gold.apbd_tematik_prioritas",
      "gold.apbd_opd_summary",
    ],
  ];

  for (const chain of chains) {
    if (chain.includes(tableName)) {
      chain.forEach((n) => {
        if (names.has(n)) rel.add(n);
      });
    }
  }

  // Generic lineage: bronze.<x>_raw <-> silver.<x>_clean <-> gold.<x>_summary
  const bare = tableName.split(".")[1] || "";
  const stem = bare.replace(/_(raw|clean|summary)$/, "");
  if (stem) {
    allTables.forEach((t) => {
      const tb = t.name.split(".")[1] || "";
      if (tb.replace(/_(raw|clean|summary)$/, "") === stem) {
        rel.add(t.name);
      }
    });
  }
  return rel;
}

export function MedallionFlowCanvas({
  tables,
  selectedName,
  busyAction,
  onSelectTable,
  onPromoteBronze,
  onPromoteSilver,
  onVectorUpdated,
}: MedallionFlowCanvasProps) {
  const [vectorStats, setVectorStats] = useState<VectorStatsResponse | null>(null);
  const [vectorBusy, setVectorBusy] = useState(false);
  const [testQuery, setTestQuery] = useState("");
  const [testResult, setTestResult] = useState<VectorSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [flowStep, setFlowStep] = useState<FlowStepState | null>(null);

  const loadVectorStats = async () => {
    try {
      const st = await fetchVectorStats();
      setVectorStats(st);
    } catch {
      // ignore offline
    }
  };

  const tableSignature = useMemo(() => tables.map((t) => `${t.name}:${t.rows}`).join("|"), [tables]);

  useEffect(() => {
    loadVectorStats();
  }, [tableSignature]);

  const bronzeTables = useMemo(() => tables.filter((t) => t.layer === "bronze"), [tables]);
  const silverTables = useMemo(() => tables.filter((t) => t.layer === "silver"), [tables]);
  const goldTables = useMemo(() => tables.filter((t) => t.layer === "gold"), [tables]);

  const related = useMemo(() => getRelatedSet(selectedName, tables), [selectedName, tables]);
  const indexedSources = useMemo(
    () => new Set((vectorStats?.sources || []).map((s) => s.source)),
    [vectorStats]
  );

  const runVisualPromoteBronze = async (tbl: string) => {
    setFlowStep({
      active: true,
      label: `Mengalirkan ${tbl} → Silver`,
      stages: [
        { title: "1. Baca Iceberg Bronze", state: "done" },
        { title: "2. Cleaning & Normalisasi", state: "active" },
        { title: "3. Tulis Parquet Silver", state: "idle" },
      ],
    });
    try {
      await onPromoteBronze(tbl);
      setFlowStep({
        active: false,
        label: `Selesai: ${tbl} dipromosikan ke Silver (siap lanjut ke Gold)`,
        stages: [
          { title: "1. Baca Iceberg Bronze", state: "done" },
          { title: "2. Cleaning & Normalisasi", state: "done" },
          { title: "3. Tulis Parquet Silver", state: "done" },
        ],
      });
    } catch {
      setFlowStep(null);
    }
  };

  const runVisualPromoteSilver = async (tbl: string) => {
    setFlowStep({
      active: true,
      label: `Mengagregasi ${tbl} → Gold`,
      stages: [
        { title: "1. Baca Iceberg Silver", state: "done" },
        { title: "2. Agregasi DuckDB SQL", state: "active" },
        { title: "3. Commit Tabel Gold", state: "idle" },
      ],
    });
    try {
      await onPromoteSilver(tbl);
      setFlowStep({
        active: false,
        label: `Selesai: ${tbl} dipromosikan ke Gold`,
        stages: [
          { title: "1. Baca Iceberg Silver", state: "done" },
          { title: "2. Agregasi DuckDB SQL", state: "done" },
          { title: "3. Commit Tabel Gold", state: "done" },
        ],
      });
    } catch {
      setFlowStep(null);
    }
  };

  const runVisualVectorIndex = async (tableName?: string) => {
    setVectorBusy(true);
    setFlowStep({
      active: true,
      label: tableName
        ? `Mengubah ${tableName} → Vector AI`
        : "Mengubah seluruh data Lakehouse → Vector AI",
      stages: [
        { title: "1. Ekstrak & Chunk Teks", state: "done" },
        { title: "2. Embedding Lokal (ONNX)", state: "active" },
        { title: "3. Simpan ke Vector Store", state: "idle" },
      ],
    });
    try {
      const res = await indexVectors(tableName);
      await loadVectorStats();
      setFlowStep({
        active: false,
        label: tableName
          ? `Selesai: ${res.chunksAdded} vector chunk dari ${tableName} (${res.elapsedMs} ms)`
          : `Selesai: ${res.totalChunks} vector chunk aktif (${res.elapsedMs} ms)`,
        stages: [
          { title: "1. Ekstrak & Chunk Teks", state: "done" },
          { title: "2. Embedding Lokal (ONNX)", state: "done" },
          { title: "3. Simpan ke Vector Store", state: "done" },
        ],
      });
      onVectorUpdated(
        tableName
          ? `Vector terindeks: ${tableName} (+${res.chunksAdded} chunks, total ${res.totalChunks} chunks dalam ${res.elapsedMs} ms).`
          : `Seluruh Vector Index diperbarui: ${res.totalChunks} chunks dari ${(res.tablesIndexed || []).length} tabel (${res.elapsedMs} ms).`
      );
    } catch (err) {
      setFlowStep(null);
      onVectorUpdated(
        err instanceof Error ? `Gagal indexing vector: ${err.message}` : "Gagal indexing vector."
      );
    } finally {
      setVectorBusy(false);
    }
  };

  const handleVectorSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testQuery.trim() || searching) return;
    setSearching(true);
    try {
      const res = await searchVectorsApi(testQuery.trim(), 4);
      setTestResult(res);
    } finally {
      setSearching(false);
    }
  };

  const renderNodeCard = (
    t: CatalogTable,
    actionLabel?: string,
    onAction?: () => void,
    canAlsoVector?: boolean
  ) => {
    const isSelected = selectedName === t.name;
    const isRelated = related.has(t.name);
    const isVectorized = indexedSources.has(t.name);

    return (
      <div
        key={t.name}
        onClick={() => onSelectTable(t.name)}
        className={`rounded-lg border p-3 transition-all cursor-pointer bg-white ${
          isSelected
            ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
            : isRelated
              ? "border-[#8fb8ad] bg-[#fafcfb]"
              : "border-[var(--border)] hover:border-[var(--control)]"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-mono-code text-[12px] font-medium text-[var(--text)] break-all">
            {t.name.split(".")[1]}
          </span>
          {isVectorized && (
            <span
              title="Sudah terindeks di Vector Store AI"
              className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#e3f2ed] text-[#125142]"
            >
              Vector
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between text-[12px] text-[var(--faint)] tabular-nums">
          <span>{t.rows.toLocaleString("id-ID")} baris</span>
          <span>{t.sizeMb.toFixed(2).replace(".", ",")} MB</span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {actionLabel && onAction && (
            <button
              type="button"
              disabled={busyAction || vectorBusy}
              onClick={(e) => {
                e.stopPropagation();
                onAction();
              }}
              className="inline-flex items-center gap-1 h-6 px-2 rounded border border-[var(--control)] bg-[var(--ground)] text-[11px] font-medium text-[var(--text)] hover:border-[var(--accent)] hover:bg-[#f2f8f6] disabled:opacity-50 cursor-pointer"
            >
              <span>{actionLabel}</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          )}
          {canAlsoVector && (
            <button
              type="button"
              disabled={busyAction || vectorBusy}
              onClick={(e) => {
                e.stopPropagation();
                runVisualVectorIndex(t.name);
              }}
              className="inline-flex items-center gap-1 h-6 px-2 rounded border border-[#b7e4c7] bg-[#f2f8f6] text-[11px] font-medium text-[#125142] hover:bg-[#e3f2ed] disabled:opacity-50 cursor-pointer"
            >
              <Sparkles className="w-3 h-3" />
              <span>Vector</span>
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="bg-[var(--ground)] border border-[var(--border)] rounded-xl p-4 md:p-5 flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-semibold text-[var(--text)]">
            Alur Visual Pipeline Medallion &amp; Vector AI
          </h2>
          <p className="text-[13px] text-[var(--muted)]">
            Klik tabel untuk melihat jalur hubungannya dari <strong>Bronze → Silver → Gold → Vector Chatbot</strong>, atau alirkan langsung dari tiap kartu.
          </p>
        </div>
        <button
          type="button"
          disabled={vectorBusy || busyAction || goldTables.length === 0}
          onClick={() => runVisualVectorIndex()}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--accent)] text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer shrink-0"
        >
          {vectorBusy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Cpu className="w-3.5 h-3.5" />
          )}
          <span>{vectorBusy ? "Meng-embed Gold..." : "Index Semua Gold ke Vector"}</span>
        </button>
      </div>

      {/* Live Visual Pipeline Progress Bar */}
      {flowStep && (
        <div className="bg-white border border-[var(--border)] rounded-lg px-4 py-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between text-[13px] font-medium text-[var(--text)]">
            <span className="flex items-center gap-2">
              {flowStep.active ? (
                <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-[var(--positive)]" />
              )}
              {flowStep.label}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            {flowStep.stages.map((st, idx) => (
              <div
                key={st.title}
                className={`rounded-md border px-3 py-2 text-[12px] flex items-center gap-2 ${
                  st.state === "done"
                    ? "border-[#b7e4c7] bg-[#f2f8f6] text-[#125142] font-medium"
                    : st.state === "active"
                      ? "border-[var(--accent)] bg-white text-[var(--text)] font-medium"
                      : "border-[var(--rule)] bg-[var(--ground)] text-[var(--faint)]"
                }`}
              >
                {st.state === "done" ? (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                ) : st.state === "active" ? (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--accent)]" />
                ) : (
                  <span className="w-3.5 h-3.5 rounded-full border border-[var(--control)] shrink-0 text-[10px] inline-flex items-center justify-center">
                    {idx + 1}
                  </span>
                )}
                <span className="truncate">{st.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4-Stage Visual Pipeline Board with Flow Arrows */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_24px_1fr_24px_1fr_24px_1.15fr] gap-3 items-stretch">
        {/* STAGE 1: BRONZE */}
        <div className="bg-white/70 border border-[var(--border)] rounded-lg p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--rule)]">
            <span className="text-[12px] font-semibold px-2 py-0.5 rounded bg-[#fdf3e7] text-[#8a4b08]">
              1. BRONZE · Mentah
            </span>
            <span className="text-[12px] text-[var(--faint)] tabular-nums">
              {bronzeTables.length} tabel
            </span>
          </div>
          {bronzeTables.length === 0 ? (
            <p className="text-[12px] text-[var(--faint)] py-3 text-center">
              Belum ada data mentah. Upload di Ingest.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {bronzeTables.map((t) =>
                renderNodeCard(t, "Ke Silver", () => runVisualPromoteBronze(t.name), false)
              )}
            </div>
          )}
        </div>

        {/* Arrow 1 -> 2 */}
        <div className="hidden lg:flex items-center justify-center text-[var(--accent)]" aria-hidden="true">
          <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
            <path d="M2 20H20M20 20L14 14M20 20L14 26" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* STAGE 2: SILVER */}
        <div className="bg-white/70 border border-[var(--border)] rounded-lg p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--rule)]">
            <span className="text-[12px] font-semibold px-2 py-0.5 rounded bg-[#edf0f2] text-[#364149]">
              2. SILVER · Bersih
            </span>
            <span className="text-[12px] text-[var(--faint)] tabular-nums">
              {silverTables.length} tabel
            </span>
          </div>
          {silverTables.length === 0 ? (
            <p className="text-[12px] text-[var(--faint)] py-3 text-center">
              Klik &ldquo;Ke Silver&rdquo; pada kartu Bronze di kiri.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {silverTables.map((t) =>
                renderNodeCard(t, "Ke Gold", () => runVisualPromoteSilver(t.name), false)
              )}
            </div>
          )}
        </div>

        {/* Arrow 2 -> 3 */}
        <div className="hidden lg:flex items-center justify-center text-[var(--accent)]" aria-hidden="true">
          <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
            <path d="M2 20H20M20 20L14 14M20 20L14 26" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* STAGE 3: GOLD */}
        <div className="bg-white/70 border border-[var(--border)] rounded-lg p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--rule)]">
            <span className="text-[12px] font-semibold px-2 py-0.5 rounded bg-[#e3f2ed] text-[#125142]">
              3. GOLD · Ringkasan
            </span>
            <span className="text-[12px] text-[var(--faint)] tabular-nums">
              {goldTables.length} tabel
            </span>
          </div>
          {goldTables.length === 0 ? (
            <p className="text-[12px] text-[var(--faint)] py-3 text-center">
              Klik &ldquo;Ke Gold&rdquo; pada kartu Silver di kiri.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {goldTables.map((t) =>
                renderNodeCard(t, "Ke Vector", () => runVisualVectorIndex(t.name), false)
              )}
            </div>
          )}
        </div>

        {/* Arrow 3 -> 4 */}
        <div className="hidden lg:flex items-center justify-center text-[var(--accent)]" aria-hidden="true">
          <svg width="24" height="40" viewBox="0 0 24 40" fill="none">
            <path d="M2 20H20M20 20L14 14M20 20L14 26" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        {/* STAGE 4: VECTOR STORE (AI READY) */}
        <div className="bg-white border border-[#b7e4c7] rounded-lg p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between pb-2 border-b border-[var(--rule)]">
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#125142]">
              <Database className="w-3.5 h-3.5" />
              4. VECTOR · Chatbot AI
            </span>
            <span className="font-mono-code text-[11px] text-[var(--faint)] tabular-nums">
              {vectorStats?.sizeKb ?? 0} KB
            </span>
          </div>

          <div className="flex items-baseline justify-between">
            <span className="text-[22px] font-semibold tabular-nums text-[var(--text)]">
              {(vectorStats?.totalChunks ?? 0).toLocaleString("id-ID")}
            </span>
            <span className="text-[12px] text-[var(--muted)]">vector chunks aktif</span>
          </div>

          {vectorStats && vectorStats.sources.length > 0 ? (
            <div className="flex flex-col gap-1 max-h-[110px] overflow-y-auto text-[12px]">
              {vectorStats.sources.map((s) => (
                <div
                  key={s.source}
                  className="flex items-center justify-between gap-2 py-0.5 border-b border-[var(--rule)] last:border-b-0"
                >
                  <span className="font-mono-code text-[11px] truncate text-[var(--text)]">
                    {s.source}
                  </span>
                  <span className="tabular-nums text-[var(--faint)] shrink-0">
                    {s.chunks}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-[var(--faint)]">
              Hanya tabel <strong>Gold</strong> yang dapat masuk ke Vector Store. Promosikan data ke Gold lalu klik <strong>Ke Vector</strong>.
            </p>
          )}

          {/* Live Semantic Search Test */}
          <form onSubmit={handleVectorSearch} className="mt-auto pt-2 border-t border-[var(--rule)] flex gap-1.5">
            <input
              type="text"
              value={testQuery}
              onChange={(e) => setTestQuery(e.target.value)}
              placeholder="Uji cari semantik..."
              className="flex-1 min-w-0 h-7 px-2 rounded border border-[var(--control)] text-[12px] bg-[var(--ground)]"
            />
            <button
              type="submit"
              disabled={searching || !testQuery.trim()}
              className="h-7 px-2 rounded bg-[var(--primary)] text-white text-[12px] inline-flex items-center cursor-pointer disabled:opacity-40"
              aria-label="Cari vector"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          </form>

          {testResult && (
            <div className="bg-[var(--ground)] border border-[var(--border)] rounded p-2 text-[11px] flex flex-col gap-1.5 max-h-[130px] overflow-y-auto">
              <div className="text-[var(--faint)] flex justify-between">
                <span>Hasil teratas</span>
                <span className="font-mono-code">{testResult.elapsedMs} ms</span>
              </div>
              {testResult.results.length === 0 ? (
                <span className="text-[var(--faint)]">Belum ada kecocokan.</span>
              ) : (
                testResult.results.map((hit) => (
                  <div key={hit.chunkId} className="border-t border-[var(--rule)] pt-1">
                    <div className="flex justify-between font-mono-code text-[10px] text-[#125142]">
                      <span className="truncate">{hit.source}</span>
                      <span>{Math.round(hit.score * 100)}%</span>
                    </div>
                    <p className="text-[var(--muted)] line-clamp-2 mt-0.5">{hit.text}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
