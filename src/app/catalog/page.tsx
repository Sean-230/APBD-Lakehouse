"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useLakehouse } from "@/components/LakehouseContext";
import {
  createTableRow,
  deleteTableRow,
  dropTable,
  fetchTableRows,
  promoteBronzeToSilver,
  promoteSilverToGold,
  rebuildGold,
  updateTableRow,
  type MedallionLayer,
  type TableRowsResponse,
} from "@/lib/api";

const PAGE_SIZE = 20;

export default function CatalogPage() {
  const { catalog, searchQuery, refreshAll } = useLakehouse();
  const [layer, setLayer] = useState<"all" | MedallionLayer>("all");
  const [selectedName, setSelectedName] = useState<string>("");

  // CRUD & Data Explorer state
  const [tableData, setTableData] = useState<TableRowsResponse | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [rowSearch, setRowSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [busyAction, setBusyAction] = useState(false);
  const [notice, setNotice] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Modal state for Create / Edit row
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.tables.filter((t) => {
      const layerOk = layer === "all" || t.layer === layer;
      const qOk = !q || t.name.toLowerCase().includes(q);
      return layerOk && qOk;
    });
  }, [catalog.tables, layer, searchQuery]);

  const selected =
    catalog.tables.find((t) => t.name === selectedName) ?? filtered[0] ?? null;

  const loadRows = useCallback(
    async (tableName: string, nextOffset: number, nextSearch: string) => {
      setLoadingRows(true);
      try {
        const res = await fetchTableRows(tableName, {
          limit: PAGE_SIZE,
          offset: nextOffset,
          search: nextSearch,
        });
        setTableData(res);
      } catch (err) {
        setTableData(null);
        setNotice({
          type: "err",
          text: err instanceof Error ? err.message : "Gagal memuat baris tabel.",
        });
      } finally {
        setLoadingRows(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!selected) {
      setTableData(null);
      return;
    }
    loadRows(selected.name, offset, rowSearch);
  }, [selected?.name, offset, rowSearch, loadRows]);

  const handleSelectTable = (name: string) => {
    setSelectedName(name);
    setOffset(0);
    setRowSearch("");
    setNotice(null);
  };

  const openCreateModal = () => {
    if (!tableData) return;
    const init: Record<string, string> = {};
    tableData.columns.forEach((c) => {
      init[c.name] = c.type.includes("bool") ? "false" : c.type.includes("int") || c.type.includes("double") || c.type.includes("float") ? "0" : "";
    });
    setFormValues(init);
    setEditingRowIdx(null);
    setModalMode("create");
  };

  const openEditModal = (row: Record<string, unknown>) => {
    if (!tableData) return;
    const init: Record<string, string> = {};
    tableData.columns.forEach((c) => {
      const v = row[c.name];
      init[c.name] = v === null || v === undefined ? "" : String(v);
    });
    setFormValues(init);
    setEditingRowIdx(Number(row._row_idx));
    setModalMode("edit");
  };

  const handleSaveRow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !modalMode) return;
    setBusyAction(true);
    setNotice(null);
    try {
      if (modalMode === "create") {
        const res = await createTableRow(selected.name, formValues);
        setNotice({
          type: "ok",
          text: `Baris ditambahkan ke ${selected.name} · Snapshot Iceberg baru: ${res.snapshot_id}`,
        });
      } else if (editingRowIdx !== null) {
        const res = await updateTableRow(selected.name, editingRowIdx, formValues);
        setNotice({
          type: "ok",
          text: `Baris #${editingRowIdx} diperbarui di ${selected.name} · Snapshot baru: ${res.snapshot_id}`,
        });
      }
      setModalMode(null);
      await refreshAll();
      await loadRows(selected.name, offset, rowSearch);
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal menyimpan baris.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleDeleteRow = async (rowIdx: number) => {
    if (!selected) return;
    if (!window.confirm(`Hapus baris #${rowIdx} dari ${selected.name}?`)) return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await deleteTableRow(selected.name, rowIdx);
      setNotice({
        type: "ok",
        text: `Baris #${rowIdx} dihapus dari ${selected.name} · Snapshot baru: ${res.snapshot_id}`,
      });
      await refreshAll();
      await loadRows(selected.name, offset, rowSearch);
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal menghapus baris.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleDropTable = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        `Hapus permanen tabel "${selected.name}" dari Apache Iceberg Catalog?`
      )
    ) {
      return;
    }
    setBusyAction(true);
    setNotice(null);
    try {
      await dropTable(selected.name);
      setNotice({ type: "ok", text: `Tabel ${selected.name} berhasil dihapus.` });
      setSelectedName("");
      setTableData(null);
      await refreshAll();
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal menghapus tabel.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handlePromoteToSilver = async () => {
    if (!selected || selected.layer !== "bronze") return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await promoteBronzeToSilver(selected.name);
      setNotice({
        type: "ok",
        text: `Promosi sukses: ${selected.name} -> ${res.silver.table} (${res.silver.rows.toLocaleString("id-ID")} baris, snapshot ${res.silver.snapshot_id}). Gold ikut diperbarui.`,
      });
      await refreshAll();
      setSelectedName(res.silver.table);
      setOffset(0);
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal mempromosikan ke Silver.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handlePromoteToGold = async () => {
    if (!selected || selected.layer !== "silver") return;
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await promoteSilverToGold(selected.name);
      const written = (res.gold || []) as { table: string; rows: number; snapshot_id: string }[];
      const summary = written
        .map((w) => `${w.table} (${w.rows.toLocaleString("id-ID")} baris)`)
        .join(", ");
      setNotice({
        type: "ok",
        text: `Promosi ke Gold berhasil: ${summary}`,
      });
      await refreshAll();
      if (written[0]?.table) {
        setSelectedName(written[0].table);
        setOffset(0);
      }
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal mempromosikan ke Gold.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleRebuildGold = async () => {
    setBusyAction(true);
    setNotice(null);
    try {
      const res = await rebuildGold();
      const names = (res.layers_written || [])
        .map((l: { table: string; rows: number }) => `${l.table} (${l.rows})`)
        .join(", ");
      setNotice({
        type: "ok",
        text: names
          ? `Gold layer diperbarui: ${names}`
          : "Tidak ada tabel Silver yang siap diagregasi ke Gold.",
      });
      await refreshAll();
      if (selected) await loadRows(selected.name, offset, rowSearch);
    } catch (err) {
      setNotice({
        type: "err",
        text: err instanceof Error ? err.message : "Gagal rebuild Gold.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const layerBadge = (l: MedallionLayer) => {
    if (l === "bronze") return "bg-[#fdf3e7] text-[#8a4b08]";
    if (l === "silver") return "bg-[#edf0f2] text-[#364149]";
    return "bg-[#e3f2ed] text-[#125142]";
  };

  const visibleCols = tableData ? tableData.columns.slice(0, 7) : [];

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.015em]">
            Katalog Apache Iceberg &amp; CRUD
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            <strong className="font-medium text-[var(--text)]">
              {catalog.tables.length} tabel terdaftar
            </strong>{" "}
            di SQLite Iceberg Catalog (<span className="font-mono-code text-[13px]">warehouse/catalog.db</span>).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={busyAction}
            onClick={handleRebuildGold}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)] disabled:opacity-60 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Rebuild Gold
          </button>
          <Link
            href="/ingest"
            className="inline-flex items-center h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium hover:bg-[var(--raised)]"
          >
            Ingest Data
          </Link>
          <Link
            href="/sql"
            className="inline-flex items-center h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30]"
          >
            Query di SQL Explorer
          </Link>
        </div>
      </div>

      {notice && (
        <div
          className={`rounded-md border px-3.5 py-2.5 text-[13px] flex items-center justify-between gap-3 ${
            notice.type === "ok"
              ? "bg-[var(--pill-positive-bg)] border-[#b7e4c7] text-[var(--pill-positive-ink)]"
              : "bg-[var(--pill-negative-bg)] border-[#f5c2c0] text-[var(--pill-negative-ink)]"
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="p-0.5 cursor-pointer"
            aria-label="Tutup notifikasi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-5 border-b border-[var(--border)]" role="tablist">
        {(
          [
            { id: "all", label: `Semua (${catalog.tables.length})` },
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

      {catalog.tables.length === 0 ? (
        <section className="bg-white border border-dashed border-[var(--control)] rounded-lg p-6 text-[14px] text-[var(--muted)]">
          Belum ada tabel di Apache Iceberg Catalog. Namespace <span className="font-mono-code">bronze</span>,{" "}
          <span className="font-mono-code">silver</span>, dan <span className="font-mono-code">gold</span> sudah siap menerima data dari halaman{" "}
          <Link href="/ingest" className="text-[var(--accent)] font-medium underline">
            Ingest &amp; Scraper
          </Link>
          .
        </section>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-7 bg-white border border-[var(--border)] rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[16px] font-semibold">Daftar Tabel Warehouse</h2>
                <span className="text-[12px] text-[var(--faint)]">Klik baris untuk kelola skema &amp; data</span>
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
                        onClick={() => handleSelectTable(t.name)}
                        className={`border-b border-[var(--rule)] last:border-b-0 cursor-pointer hover:bg-[var(--raised)] ${
                          selected?.name === t.name ? "bg-[var(--raised)]" : ""
                        }`}
                      >
                        <td className="font-mono-code text-[13px] font-medium py-3 pr-3">
                          {t.name}
                        </td>
                        <td className="py-3 pr-3">
                          <span className={`text-[12px] font-medium px-2 py-0.5 rounded capitalize ${layerBadge(t.layer)}`}>
                            {t.layer}
                          </span>
                        </td>
                        <td className="text-right tabular-nums py-3 pr-3">
                          {t.rows.toLocaleString("id-ID")}
                        </td>
                        <td className="text-right tabular-nums py-3 pr-3">
                          {t.sizeMb.toFixed(2).replace(".", ",")} MB
                        </td>
                        <td className="font-mono-code text-[12px] text-[var(--faint)] py-3">
                          {t.snapshotId.slice(-8)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {selected && (
              <section className="lg:col-span-5 bg-white border border-[var(--border)] rounded-lg p-5">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <h2 className="font-mono-code text-[15px] font-semibold">{selected.name}</h2>
                    <p className="text-[12px] text-[var(--faint)]">
                      {selected.format} · {selected.files} file Parquet · {selected.updatedAt}
                    </p>
                  </div>
                  <span className={`text-[12px] font-medium px-2 py-0.5 rounded uppercase ${layerBadge(selected.layer)}`}>
                    {selected.layer}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-4 pb-3 border-b border-[var(--rule)]">
                  {selected.layer === "bronze" && (
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={handlePromoteToSilver}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
                    >
                      <span>Promote ke Silver</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {selected.layer === "silver" && (
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={handlePromoteToGold}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
                    >
                      <span>Promote ke Gold</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={handleDropTable}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-[#f5c2c0] bg-white text-[var(--negative)] text-[13px] font-medium hover:bg-[var(--pill-negative-bg)] disabled:opacity-60 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Hapus Tabel
                  </button>
                </div>

                <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
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
                        <tr key={c.name} className="border-b border-[var(--rule)] last:border-b-0">
                          <td className="font-mono-code py-2 pr-2">{c.name}</td>
                          <td className="font-mono-code text-[var(--faint)] py-2 pr-2">{c.type}</td>
                          <td className="text-[var(--muted)] py-2">{c.sample}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>

          {/* Full-width Row CRUD Explorer for Selected Table */}
          {selected && (
            <section className="bg-white border border-[var(--border)] rounded-lg p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-[16px] font-semibold">
                    Data &amp; CRUD — <span className="font-mono-code text-[15px]">{selected.name}</span>
                  </h2>
                  <p className="text-[12px] text-[var(--faint)]">
                    Setiap tambah, ubah, atau hapus baris otomatis membuat snapshot Apache Iceberg baru
                    {selected.layer === "silver" ? " dan memperbarui layer Gold." : "."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="search"
                    value={rowSearch}
                    onChange={(e) => {
                      setRowSearch(e.target.value);
                      setOffset(0);
                    }}
                    placeholder="Filter baris..."
                    className="h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] w-48"
                  />
                  <button
                    type="button"
                    disabled={busyAction || !tableData}
                    onClick={openCreateModal}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Tambah Baris
                  </button>
                </div>
              </div>

              {loadingRows ? (
                <p className="text-[13px] text-[var(--faint)] py-4">Memuat baris dari Apache Iceberg...</p>
              ) : !tableData || tableData.rows.length === 0 ? (
                <p className="text-[13px] text-[var(--faint)] py-4">
                  Tidak ada baris yang cocok.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-[12px] text-[var(--faint)]">
                          <th className="text-right font-medium pb-2 pr-3">#</th>
                          {visibleCols.map((c) => (
                            <th key={c.name} className="text-left font-mono-code font-medium pb-2 pr-3 whitespace-nowrap">
                              {c.name}
                            </th>
                          ))}
                          <th className="text-right font-medium pb-2 whitespace-nowrap">Aksi</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableData.rows.map((row) => {
                          const rIdx = Number(row._row_idx);
                          return (
                            <tr
                              key={rIdx}
                              className="border-b border-[var(--rule)] last:border-b-0 hover:bg-[var(--raised)]"
                            >
                              <td className="text-right tabular-nums text-[var(--faint)] py-2.5 pr-3">
                                {rIdx}
                              </td>
                              {visibleCols.map((c) => (
                                <td key={c.name} className="py-2.5 pr-3 max-w-[220px] truncate">
                                  {String(row[c.name] ?? "—")}
                                </td>
                              ))}
                              <td className="text-right py-2.5 whitespace-nowrap">
                                <button
                                  type="button"
                                  disabled={busyAction}
                                  onClick={() => openEditModal(row)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[var(--text)] hover:bg-[var(--active)] cursor-pointer mr-1"
                                >
                                  <Pencil className="w-3 h-3" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  disabled={busyAction}
                                  onClick={() => handleDeleteRow(rIdx)}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-[var(--negative)] hover:bg-[var(--pill-negative-bg)] cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Hapus
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--rule)] text-[12px] text-[var(--muted)]">
                    <span className="tabular-nums">
                      Menampilkan {offset + 1}–{Math.min(offset + PAGE_SIZE, tableData.filteredRows)} dari{" "}
                      {tableData.filteredRows.toLocaleString("id-ID")} baris
                      {tableData.columns.length > 7
                        ? ` (menampilkan 7 dari ${tableData.columns.length} kolom; klik Edit untuk semua kolom)`
                        : ""}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                        className="h-7 px-2.5 rounded border border-[var(--control)] bg-white text-[12px] disabled:opacity-40 cursor-pointer"
                      >
                        Sebelumnya
                      </button>
                      <button
                        type="button"
                        disabled={offset + PAGE_SIZE >= tableData.filteredRows}
                        onClick={() => setOffset(offset + PAGE_SIZE)}
                        className="h-7 px-2.5 rounded border border-[var(--control)] bg-white text-[12px] disabled:opacity-40 cursor-pointer"
                      >
                        Berikutnya
                      </button>
                    </div>
                  </div>
                </>
              )}
            </section>
          )}
        </>
      )}

      {/* Snapshot History */}
      <section className="bg-white border border-[var(--border)] rounded-lg p-5">
        <div className="mb-3">
          <h2 className="text-[16px] font-semibold">Riwayat Snapshot Apache Iceberg</h2>
          <p className="text-[12px] text-[var(--faint)]">
            Setiap operasi append/overwrite/CRUD tercatat immutable di metadata Iceberg.
          </p>
        </div>
        {catalog.snapshots.length === 0 ? (
          <p className="text-[13px] text-[var(--faint)]">Belum ada snapshot tercatat.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[12px] text-[var(--faint)]">
                  <th className="text-left font-medium pb-2 pr-3">Snapshot ID</th>
                  <th className="text-left font-medium pb-2 pr-3">Tabel</th>
                  <th className="text-left font-medium pb-2 pr-3">Operasi</th>
                  <th className="text-right font-medium pb-2">Waktu Commit</th>
                </tr>
              </thead>
              <tbody>
                {catalog.snapshots.slice(0, 15).map((s) => (
                  <tr key={`${s.table}-${s.id}`} className="border-b border-[var(--rule)] last:border-b-0">
                    <td className="font-mono-code py-2.5 pr-3">{s.id}</td>
                    <td className="font-mono-code py-2.5 pr-3">{s.table}</td>
                    <td className="py-2.5 pr-3 capitalize">{s.operation}</td>
                    <td className="text-right tabular-nums py-2.5">{s.committedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Modal Create / Edit Row */}
      {modalMode && tableData && selected && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white border border-[var(--border)] rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
              <div>
                <h3 className="text-[16px] font-semibold">
                  {modalMode === "create"
                    ? `Tambah Baris ke ${selected.name}`
                    : `Edit Baris #${editingRowIdx} — ${selected.name}`}
                </h3>
                <p className="text-[12px] text-[var(--faint)]">
                  Nilai otomatis di-cast ke tipe skema Apache Iceberg.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="p-1 rounded hover:bg-[var(--raised)] cursor-pointer"
                aria-label="Tutup modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveRow} className="flex flex-col flex-1 overflow-hidden">
              <div className="p-5 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {tableData.columns.map((c) => (
                  <label key={c.name} className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-[var(--text)] flex items-center justify-between gap-2">
                      <span className="font-mono-code">{c.name}</span>
                      <span className="font-mono-code text-[11px] text-[var(--faint)]">{c.type}</span>
                    </span>
                    {c.type.includes("bool") ? (
                      <select
                        value={formValues[c.name] ?? "false"}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [c.name]: e.target.value }))
                        }
                        className="h-9 px-2.5 rounded-md border border-[var(--control)] bg-white text-[13px]"
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        type={
                          c.type.includes("int") || c.type.includes("double") || c.type.includes("float")
                            ? "number"
                            : "text"
                        }
                        step="any"
                        value={formValues[c.name] ?? ""}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [c.name]: e.target.value }))
                        }
                        className="h-9 px-2.5 rounded-md border border-[var(--control)] bg-white text-[13px]"
                      />
                    )}
                  </label>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[var(--border)] bg-[var(--ground)]">
                <button
                  type="button"
                  onClick={() => setModalMode(null)}
                  className="h-8 px-3 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="h-8 px-4 rounded-md bg-[var(--primary)] text-[var(--primary-ink)] text-[13px] font-medium hover:bg-[#2a2d30] disabled:opacity-60 cursor-pointer"
                >
                  {busyAction ? "Menyimpan..." : "Simpan ke Iceberg"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
