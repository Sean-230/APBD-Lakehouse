"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  LayoutDashboard,
  Menu,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useLakehouse } from "./LakehouseContext";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const {
    overview,
    backendOnline,
    searchQuery,
    setSearchQuery,
    ingestRecords,
    refreshAll,
    handleReset,
  } = useLakehouse();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const reviewCount = ingestRecords.filter(
    (r) => r.status === "Perlu Review"
  ).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        document.activeElement !== searchRef.current &&
        document.activeElement?.tagName !== "TEXTAREA" &&
        document.activeElement?.tagName !== "INPUT"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onResetClick = async () => {
    if (!window.confirm("Kosongkan seluruh tabel Apache Iceberg dan mulai dari nol?")) {
      return;
    }
    setResetting(true);
    try {
      await handleReset();
    } finally {
      setResetting(false);
    }
  };

  const navLinkClass = (active: boolean) =>
    `flex items-center gap-2.5 h-8 px-2 rounded-lg text-[14px] transition-colors ${
      active
        ? "bg-[var(--active)] text-[var(--text)] font-medium"
        : "text-[var(--muted)] hover:bg-[var(--raised)] hover:text-[var(--text)]"
    }`;

  return (
    <div className="framed-shell">
      <div className="hidden md:flex items-center gap-2.5 px-4 col-start-1 row-start-1">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="shrink-0"
        >
          <path
            d="M12 3L3 7.5L12 12L21 7.5L12 3Z"
            stroke="#166553"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M3 12L12 16.5L21 12"
            stroke="#166553"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M3 16.5L12 21L21 16.5"
            stroke="#166553"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text)]">
          SuraLake
        </span>
        <span className="ml-auto text-[11px] text-[var(--muted)] bg-[var(--active)] px-1.5 py-0.5 rounded">
          Pemkot SBY
        </span>
      </div>

      <header className="flex items-center justify-between gap-3 px-3 md:pl-2 md:pr-4 col-start-1 md:col-start-2 row-start-1">
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          className="md:hidden inline-flex items-center gap-2 h-8 px-2.5 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium"
          aria-label="Toggle navigasi"
        >
          {drawerOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          <span>SuraLake</span>
        </button>

        <div className="hidden md:block relative w-full max-w-[440px]">
          <Search className="w-3.5 h-3.5 text-[var(--faint)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={searchRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Cari OPD atau tabel Iceberg..."
            className="w-full h-8 pl-8 pr-10 rounded-md border border-[var(--border)] bg-white text-[13px] text-[var(--text)] placeholder:text-[var(--faint)] focus:outline-none focus:border-[var(--accent)]"
          />
          <span className="font-mono-code text-[11px] text-[var(--faint)] border border-[var(--border)] bg-[var(--ground)] rounded px-1.5 py-px absolute right-2 top-1/2 -translate-y-1/2">
            /
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <span className="hidden sm:inline font-mono-code text-[12px] text-[var(--muted)]">
            {overview.latestSnapshotId
              ? `snap_${overview.latestSnapshotId.slice(-8)}`
              : "Warehouse kosong"}
          </span>
          <button
            type="button"
            onClick={() => refreshAll()}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--control)] bg-white text-[13px] font-medium text-[var(--text)] hover:bg-[var(--raised)] cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {drawerOpen && (
        <div
          onClick={() => setDrawerOpen(false)}
          className="md:hidden fixed inset-x-0 top-12 bottom-0 bg-black/25 z-30"
        />
      )}

      <aside
        className={`flex flex-col gap-0.5 px-3 pt-2 pb-4 bg-[var(--ground)] md:sticky md:top-12 md:h-[calc(100svh-48px)] overflow-y-auto z-40 fixed top-12 bottom-0 left-0 w-[240px] md:w-auto border-r md:border-r-0 border-[var(--border)] transition-transform md:translate-x-0 ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-2 mt-1.5 mb-1.5 text-[12px] text-[var(--faint)]">
          Eksekutif (Gold)
        </div>
        <Link
          href="/"
          onClick={() => setDrawerOpen(false)}
          className={navLinkClass(pathname === "/")}
        >
          <LayoutDashboard className="w-4 h-4 shrink-0 stroke-[1.6]" />
          <span>Ikhtisar APBD</span>
        </Link>

        <div className="px-2 mt-5 mb-1.5 text-[12px] text-[var(--faint)]">
          Lakehouse Studio
        </div>
        <Link
          href="/catalog"
          onClick={() => setDrawerOpen(false)}
          className={navLinkClass(pathname === "/catalog")}
        >
          <Database className="w-4 h-4 shrink-0 stroke-[1.6]" />
          <span>Katalog Iceberg</span>
        </Link>
        <Link
          href="/ingest"
          onClick={() => setDrawerOpen(false)}
          className={navLinkClass(pathname === "/ingest")}
        >
          <UploadCloud className="w-4 h-4 shrink-0 stroke-[1.6]" />
          <span>Ingest &amp; Scraper</span>
          {reviewCount > 0 && (
            <span className="ml-auto text-[11px] font-medium tabular-nums px-1.5 py-px rounded-full bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]">
              {reviewCount}
            </span>
          )}
        </Link>
        <Link
          href="/sql"
          onClick={() => setDrawerOpen(false)}
          className={navLinkClass(pathname === "/sql")}
        >
          <Terminal className="w-4 h-4 shrink-0 stroke-[1.6]" />
          <span>SQL Explorer</span>
        </Link>

        <div className="mt-auto pt-3 px-2 border-t border-[var(--border)] text-[12px] text-[var(--muted)] flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-[var(--text)] font-medium">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                backendOnline ? "bg-[var(--positive)]" : "bg-[var(--negative)]"
              }`}
            />
            <span>{backendOnline ? "PyIceberg · DuckDB" : "Backend Offline"}</span>
          </div>
          <div className="text-[12px] text-[var(--faint)] tabular-nums">
            {overview.totals.tableCount} tabel · {overview.totals.opdCount} OPD
          </div>
          {overview.totals.tableCount > 0 && (
            <button
              type="button"
              disabled={resetting}
              onClick={onResetClick}
              className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-[var(--negative)] hover:underline cursor-pointer w-fit"
            >
              <Trash2 className="w-3 h-3" />
              <span>{resetting ? "Mengosongkan..." : "Reset Warehouse"}</span>
            </button>
          )}
        </div>
      </aside>

      <main className="framed-sheet col-start-1 md:col-start-2 row-start-2 flex flex-col gap-6">
        {children}
      </main>
    </div>
  );
}
