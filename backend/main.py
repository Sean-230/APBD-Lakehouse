from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from chatbot import chat_with_lakehouse, get_chat_status
from vector_store import get_vector_stats, index_table_to_vectors, rebuild_all_vectors, search_vectors
from lakehouse import (
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
async def ingest_file(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="File kosong.")
    try:
        return ingest_uploaded_file(file.filename or "upload.bin", content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Gagal memproses file: {exc}") from exc


@app.post("/api/ingest/web")
def ingest_web(req: WebIngestRequest):
    if not req.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL harus diawali http:// atau https://")
    try:
        return ingest_web_url(req.url)
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
def edit_row(namespace: str, table: str, row_idx: int, payload: RowPayload):
    try:
        return update_table_row(namespace, table, row_idx, payload.data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/tables/{namespace}/{table}/rows/{row_idx}")
def remove_row(namespace: str, table: str, row_idx: int):
    try:
        return delete_table_row(namespace, table, row_idx)
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
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatHistoryItem] = []


@app.get("/api/chat/status")
def chat_status():
    return get_chat_status()


@app.post("/api/chat")
def chat_endpoint(req: ChatRequest):
    try:
        return chat_with_lakehouse(
            req.message, [{"role": h.role, "content": h.content} for h in req.history]
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class VectorIndexRequest(BaseModel):
    table_name: str | None = None


class VectorSearchRequest(BaseModel):
    query: str
    top_k: int = 6


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
