export type MedallionLayer = "bronze" | "silver" | "gold";

export interface OpdSummaryRow {
  nama_opd: string;
  jumlah_sub_kegiatan: number;
  jumlah_pekerjaan: number;
  alokasi_rp: number;
  penggunaan_dana_rp: number;
  total_realisasi_rp: number;
  sp2d_rp: number;
  serapan_sp2d_pct: number;
  jumlah_anomali: number;
}

export interface TematikRow {
  tema: string;
  komponen: number;
  total_rp: number;
}

export interface OverviewResponse {
  isEmpty: boolean;
  totals: {
    alokasiRp: number;
    realisasiRp: number;
    sp2dRp: number;
    serapanPct: number;
    opdCount: number;
    anomaliCount: number;
    tableCount: number;
  };
  layers: Record<MedallionLayer, { tables: number; rows: number; sizeMb: number }>;
  opd: OpdSummaryRow[];
  tematik: TematikRow[];
  latestSnapshotId: string | null;
}

export interface CatalogColumn {
  name: string;
  type: string;
  sample: string;
}

export interface CatalogTable {
  name: string;
  layer: MedallionLayer;
  format: string;
  rows: number;
  files: number;
  sizeMb: number;
  snapshotId: string;
  updatedAt: string;
  columns: CatalogColumn[];
}

export interface SnapshotItem {
  id: string;
  table: string;
  layer: MedallionLayer;
  committedAt: string;
  operation: string;
}

export interface CatalogResponse {
  tables: CatalogTable[];
  snapshots: SnapshotItem[];
}

export interface IngestRecord {
  id: string;
  sourceName: string;
  sourceType: "xlsx" | "csv" | "pdf" | "image" | "web";
  targetTable: string;
  sha256: string;
  rowsExtracted: number;
  ingestedAt: string;
  status: "Committed" | "Perlu Review" | "Unchanged";
}

export interface SqlResponse {
  columns: string[];
  rows: string[][];
  rowCount: number;
  elapsedMs: number;
  registeredTables: string[];
}

export const EMPTY_OVERVIEW: OverviewResponse = {
  isEmpty: true,
  totals: {
    alokasiRp: 0,
    realisasiRp: 0,
    sp2dRp: 0,
    serapanPct: 0,
    opdCount: 0,
    anomaliCount: 0,
    tableCount: 0,
  },
  layers: {
    bronze: { tables: 0, rows: 0, sizeMb: 0 },
    silver: { tables: 0, rows: 0, sizeMb: 0 },
    gold: { tables: 0, rows: 0, sizeMb: 0 },
  },
  opd: [],
  tematik: [],
  latestSnapshotId: null,
};

export function fmtRp(rp: number): string {
  if (rp === 0) return "Rp 0";
  const abs = Math.abs(rp);
  if (abs >= 1e12) return `Rp ${(rp / 1e12).toFixed(2).replace(".", ",")} T`;
  if (abs >= 1e9) return `Rp ${(rp / 1e9).toFixed(2).replace(".", ",")} M`;
  if (abs >= 1e6) return `Rp ${(rp / 1e6).toFixed(1).replace(".", ",")} jt`;
  return `Rp ${rp.toLocaleString("id-ID")}`;
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1).replace(".", ",")}%`;
}

export async function fetchOverview(): Promise<OverviewResponse> {
  const res = await fetch("/api/overview", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  const res = await fetch("/api/catalog", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchIngestLogs(): Promise<IngestRecord[]> {
  const res = await fetch("/api/ingest/logs", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.logs ?? [];
}

async function parseApiJson(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status >= 500) {
      throw new Error(
        "Backend FastAPI (port 8000) belum berjalan atau tidak merespons. Jalankan: cd backend && source .venv/bin/activate && uvicorn main:app --port 8000 --reload"
      );
    }
    throw new Error(text.slice(0, 160) || `HTTP ${res.status}`);
  }
}

export async function uploadIngestFile(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/ingest/file", { method: "POST", body: fd });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function ingestWebUrl(url: string) {
  const res = await fetch("/api/ingest/web", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function executeSql(query: string): Promise<SqlResponse> {
  const res = await fetch("/api/sql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function resetWarehouse() {
  const res = await fetch("/api/reset", { method: "POST" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export interface TableRowsResponse {
  table: string;
  layer: MedallionLayer;
  columns: { name: string; type: string }[];
  totalRows: number;
  filteredRows: number;
  offset: number;
  limit: number;
  rows: Record<string, unknown>[];
}

function splitIdent(fullName: string): [string, string] {
  const [ns, tbl] = fullName.split(".");
  return [ns, tbl];
}

export async function fetchTableRows(
  fullName: string,
  params: { limit?: number; offset?: number; search?: string } = {}
): Promise<TableRowsResponse> {
  const [ns, tbl] = splitIdent(fullName);
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  if (params.search) qs.set("search", params.search);
  const res = await fetch(`/api/tables/${ns}/${tbl}/rows?${qs.toString()}`, { cache: "no-store" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function createTableRow(fullName: string, rowData: Record<string, unknown>) {
  const [ns, tbl] = splitIdent(fullName);
  const res = await fetch(`/api/tables/${ns}/${tbl}/rows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: rowData }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function updateTableRow(
  fullName: string,
  rowIdx: number,
  rowData: Record<string, unknown>
) {
  const [ns, tbl] = splitIdent(fullName);
  const res = await fetch(`/api/tables/${ns}/${tbl}/rows/${rowIdx}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: rowData }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function deleteTableRow(fullName: string, rowIdx: number) {
  const [ns, tbl] = splitIdent(fullName);
  const res = await fetch(`/api/tables/${ns}/${tbl}/rows/${rowIdx}`, { method: "DELETE" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function dropTable(fullName: string) {
  const [ns, tbl] = splitIdent(fullName);
  const res = await fetch(`/api/tables/${ns}/${tbl}`, { method: "DELETE" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function promoteBronzeToSilver(sourceTable: string, targetTable?: string) {
  const res = await fetch("/api/transform/silver", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_table: sourceTable, target_table: targetTable || null }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function rebuildGold() {
  const res = await fetch("/api/transform/gold", { method: "POST" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function promoteSilverToGold(sourceTable: string, targetTable?: string) {
  const res = await fetch("/api/transform/gold/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_table: sourceTable, target_table: targetTable || null }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function saveSqlAsGold(query: string, tableName: string) {
  const res = await fetch("/api/sql/save-gold", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, table_name: tableName }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export interface ChatStatusResponse {
  configured: boolean;
  provider: string;
  model: string;
}

export interface ChatSqlTrace {
  query: string;
  reason?: string;
  rowCount?: number;
  elapsedMs?: number;
  error?: string;
}

export interface ChatResponse {
  answer: string;
  model: string;
  sqlUsed: ChatSqlTrace[];
  snapshotId: string | null;
}

export async function fetchChatStatus(): Promise<ChatStatusResponse> {
  const res = await fetch("/api/chat/status", { cache: "no-store" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function sendChatMessage(
  message: string,
  history: { role: "user" | "assistant"; content: string }[]
): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export interface VectorSourceStat {
  source: string;
  layer: string;
  chunks: number;
}

export interface VectorStatsResponse {
  totalChunks: number;
  sizeKb: number;
  model: string;
  sources: VectorSourceStat[];
}

export interface VectorSearchHit {
  chunkId: string;
  source: string;
  layer: string;
  score: number;
  text: string;
}

export interface VectorSearchResponse {
  query: string;
  totalChunks?: number;
  elapsedMs: number;
  results: VectorSearchHit[];
}

export async function fetchVectorStats(): Promise<VectorStatsResponse> {
  const res = await fetch("/api/vectors/stats", { cache: "no-store" });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function indexVectors(tableName?: string) {
  const res = await fetch("/api/vectors/index", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ table_name: tableName || null }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

export async function searchVectorsApi(
  query: string,
  topK = 5
): Promise<VectorSearchResponse> {
  const res = await fetch("/api/vectors/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK }),
  });
  const data = await parseApiJson(res);
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}
