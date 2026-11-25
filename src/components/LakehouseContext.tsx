"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  EMPTY_OVERVIEW,
  fetchCatalog,
  fetchIngestLogs,
  fetchOverview,
  resetWarehouse,
  type CatalogResponse,
  type IngestRecord,
  type OverviewResponse,
} from "@/lib/api";

interface LakehouseContextValue {
  overview: OverviewResponse;
  catalog: CatalogResponse;
  ingestRecords: IngestRecord[];
  loading: boolean;
  backendOnline: boolean;
  error: string | null;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  refreshAll: () => Promise<void>;
  handleReset: () => Promise<void>;
}

const LakehouseContext = createContext<LakehouseContextValue | null>(null);

export function LakehouseProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = useState<OverviewResponse>(EMPTY_OVERVIEW);
  const [catalog, setCatalog] = useState<CatalogResponse>({ tables: [], snapshots: [] });
  const [ingestRecords, setIngestRecords] = useState<IngestRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const refreshAll = useCallback(async () => {
    try {
      const [ov, cat, logs] = await Promise.all([
        fetchOverview(),
        fetchCatalog(),
        fetchIngestLogs(),
      ]);
      setOverview(ov);
      setCatalog(cat);
      setIngestRecords(logs);
      setBackendOnline(true);
      setError(null);
    } catch {
      setBackendOnline(false);
      setError("Backend FastAPI (port 8000) belum berjalan. Jalankan uvicorn terlebih dahulu.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const handleReset = useCallback(async () => {
    await resetWarehouse();
    await refreshAll();
  }, [refreshAll]);

  return (
    <LakehouseContext.Provider
      value={{
        overview,
        catalog,
        ingestRecords,
        loading,
        backendOnline,
        error,
        searchQuery,
        setSearchQuery,
        refreshAll,
        handleReset,
      }}
    >
      {children}
    </LakehouseContext.Provider>
  );
}

export function useLakehouse() {
  const ctx = useContext(LakehouseContext);
  if (!ctx) throw new Error("useLakehouse must be used within LakehouseProvider");
  return ctx;
}
