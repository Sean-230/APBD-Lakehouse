import logging
import threading
import zipfile
import time
from collections import defaultdict, deque
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from chatbot import QuotaError, chat_with_lakehouse
from vector_store import get_vector_stats, index_table_to_vectors, rebuild_all_vectors, search_vectors
from lakehouse import (
    StaleTableError,
    create_table_row,
    delete_table_row,
    drop_iceberg_table,
    get_catalog_summary,
    get_overview_data,
    get_table_rows,
    ingest_uploaded_file,
    ingest_web_url,
    promote_bronze_to_silver,
    promote_silver_to_gold,
    read_ingest_logs,
    rebuild_gold,
    reset_warehouse,
    run_duckdb_sql,
    save_sql_as_gold,
    update_table_row,
)

app = FastAPI(title="SuraLake API — APBD Surabaya Apache Iceberg Lakehouse")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # keep in step with next.config.ts
CHAT_PER_MINUTE = 15
CHAT_PER_MINUTE_ALL = 60  # all clients together; the per-client address can be faked
log = logging.getLogger("suralake")


@app.middleware("http")
async def block_cross_site_writes(request: Request, call_next):
    # Browsers set this header themselves; another website cannot fake it.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "Permintaan dari situs lain ditolak."}, status_code=403)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WebIngestRequest(BaseModel):
    url: str


class SqlRequest(BaseModel):
    query: str


@app.get("/api/health")
def health():
    return {"status": "ok", "engine": "PyIceberg + DuckDB"}


@app.get("/api/overview")
def overview():
    return get_overview_data()


@app.get("/api/catalog")
def catalog():
    return get_catalog_summary()


@app.get("/api/ingest/logs")
def ingest_logs():
    return {"logs": read_ingest_logs()}


@app.post("/api/ingest/file")
def ingest_file(file: UploadFile = File(...)):  # plain def: runs in a thread, server stays responsive
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="File kosong.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Ukuran berkas melebihi 50 MB.")
    try:
        return ingest_uploaded_file(file.filename or "upload.bin", content)
    except (ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=f"Gagal memproses file: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Gagal memproses file: {exc}") from exc


@app.post("/api/ingest/web")
def ingest_web(req: WebIngestRequest):
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL harus diawali http:// atau https://")
    try:
        return ingest_web_url(req.url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Gagal mengambil URL: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Gagal mengambil URL: {exc}") from exc


@app.post("/api/sql")
def execute_sql(req: SqlRequest):
    try:
        return run_duckdb_sql(req.query)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/reset")
def reset():
    return reset_warehouse()


class RowPayload(BaseModel):
    data: dict[str, Any]


class PromoteRequest(BaseModel):
    source_table: str
    target_table: str | None = None


@app.get("/api/tables/{namespace}/{table}/rows")
def list_rows(
    namespace: str,
    table: str,
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    search: str = Query(""),
):
    try:
        return get_table_rows(namespace, table, limit=limit, offset=offset, search=search)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/tables/{namespace}/{table}/rows")
def add_row(namespace: str, table: str, payload: RowPayload):
    try:
        return create_table_row(namespace, table, payload.data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/api/tables/{namespace}/{table}/rows/{row_idx}")
def edit_row(namespace: str, table: str, row_idx: int, payload: RowPayload, snapshot_id: str = Query(...)):
    try:
        return update_table_row(namespace, table, row_idx, payload.data, snapshot_id)
    except StaleTableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/tables/{namespace}/{table}/rows/{row_idx}")
def remove_row(namespace: str, table: str, row_idx: int, snapshot_id: str = Query(...)):
    try:
        return delete_table_row(namespace, table, row_idx, snapshot_id)
    except StaleTableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/tables/{namespace}/{table}")
def remove_table(namespace: str, table: str):
    try:
        return drop_iceberg_table(namespace, table)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/transform/silver")
def transform_silver(req: PromoteRequest):
    try:
        return promote_bronze_to_silver(req.source_table, req.target_table)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/transform/gold")
def transform_gold():
    try:
        return rebuild_gold()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/transform/gold/promote")
def transform_silver_to_gold(req: PromoteRequest):
    try:
        return promote_silver_to_gold(req.source_table, req.target_table)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class SaveGoldRequest(BaseModel):
    query: str
    table_name: str


@app.post("/api/sql/save-gold")
def sql_save_gold(req: SaveGoldRequest):
    try:
        return save_sql_as_gold(req.query, req.table_name)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class ChatHistoryItem(BaseModel):
    role: str
    content: str = Field(max_length=20000)


class ChatRequest(BaseModel):
    message: str = Field(max_length=2000)
    history: list[ChatHistoryItem] = Field(default=[], max_length=20)


# shortcut: per-process memory; move to a shared store if the backend ever runs several workers.
_chat_hits: defaultdict[str, deque[float]] = defaultdict(deque)
_chat_lock = threading.Lock()


def _check_chat_rate(request: Request) -> None:
    # The Next.js proxy appends the real client address as the last X-Forwarded-For entry.
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    client = forwarded or (request.client.host if request.client else "unknown")
    now = time.monotonic()
    with _chat_lock:
        for key in [k for k, v in _chat_hits.items() if v and now - v[-1] > 60]:
            del _chat_hits[key]
        for key, limit in ((client, CHAT_PER_MINUTE), ("*all*", CHAT_PER_MINUTE_ALL)):
            hits = _chat_hits[key]
            while hits and now - hits[0] > 60:
                hits.popleft()
            if len(hits) >= limit:
                raise HTTPException(status_code=429, detail="Terlalu banyak pertanyaan. Coba lagi dalam satu menit.")
        _chat_hits[client].append(now)
        _chat_hits["*all*"].append(now)


@app.post("/api/chat")
def chat_endpoint(req: ChatRequest, request: Request):
    _check_chat_rate(request)
    try:
        return chat_with_lakehouse(
            req.message, [{"role": h.role, "content": h.content} for h in req.history]
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except QuotaError as exc:
        log.warning("%s", exc)
        raise HTTPException(
            status_code=429, detail="Kuota asisten AI sedang penuh. Coba lagi sekitar satu menit lagi."
        ) from exc
    except Exception as exc:
        log.exception("chat failed")
        raise HTTPException(
            status_code=500, detail="Asisten AI sedang bermasalah. Silakan coba lagi sebentar."
        ) from exc


class VectorIndexRequest(BaseModel):
    table_name: str | None = None


class VectorSearchRequest(BaseModel):
    query: str = Field(max_length=2000)
    top_k: int = Field(default=6, ge=1, le=20)


@app.get("/api/vectors/stats")
def vector_stats():
    return get_vector_stats()


@app.post("/api/vectors/index")
def vector_index(req: VectorIndexRequest):
    try:
        if req.table_name:
            return index_table_to_vectors(req.table_name)
        return rebuild_all_vectors()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/vectors/search")
def vector_search(req: VectorSearchRequest):
    try:
        return search_vectors(req.query, top_k=req.top_k)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
