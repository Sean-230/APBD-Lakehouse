"use client";

import React, { createContext, useContext, useState } from "react";
import {
  ICEBERG_SNAPSHOTS,
  INITIAL_INGEST_RECORDS,
  type IcebergSnapshot,
  type IngestRecord,
} from "@/lib/lakehouse-data";

interface LakehouseContextValue {
  snapshots: IcebergSnapshot[];
  snapshotIdx: number;
  setSnapshotIdx: (idx: number) => void;
  currentSnapshot: IcebergSnapshot;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  ingestRecords: IngestRecord[];
  addIngestRecord: (record: IngestRecord) => void;
}

const LakehouseContext = createContext<LakehouseContextValue | null>(null);

export function LakehouseProvider({ children }: { children: React.ReactNode }) {
  const [snapshotIdx, setSnapshotIdx] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [ingestRecords, setIngestRecords] = useState<IngestRecord[]>(
    INITIAL_INGEST_RECORDS
  );

  const addIngestRecord = (record: IngestRecord) => {
    setIngestRecords((prev) => [record, ...prev]);
  };

  return (
    <LakehouseContext.Provider
      value={{
        snapshots: ICEBERG_SNAPSHOTS,
        snapshotIdx,
        setSnapshotIdx,
        currentSnapshot: ICEBERG_SNAPSHOTS[snapshotIdx],
        searchQuery,
        setSearchQuery,
        ingestRecords,
        addIngestRecord,
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
