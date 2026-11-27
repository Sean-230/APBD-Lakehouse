from __future__ import annotations

import hashlib
import os
import re
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from lakehouse import (
    NAMESPACES,
    ROOT_DIR,
    WAREHOUSE_DIR,
    _read_table_arrow,
    ensure_warehouse,
    get_catalog,
)

VECTOR_STORE_PATH = WAREHOUSE_DIR / "vectors.parquet"
EMBED_MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
EMBED_BATCH_SIZE = 32  # small batches keep memory low inside containers

_VECTOR_LOCK = threading.RLock()
_EMBEDDER: Any = None
_OCR_ENGINE: Any = None


def _get_embedder() -> Any:
    # No fallback model: vectors from two models cannot be compared.
    global _EMBEDDER
    if _EMBEDDER is None:
        from fastembed import TextEmbedding

        _EMBEDDER = TextEmbedding(model_name=EMBED_MODEL_NAME)
    return _EMBEDDER


def extract_image_ocr(image_path: Path) -> str:
    """Extract text from an uploaded PNG/JPG/WEBP image locally using RapidOCR."""
    global _OCR_ENGINE
    try:
        if _OCR_ENGINE is None:
            from rapidocr_onnxruntime import RapidOCR

            _OCR_ENGINE = RapidOCR()
        result, _ = _OCR_ENGINE(str(image_path))
        if not result:
            return ""
        lines = [str(item[1]).strip() for item in result if len(item) >= 2 and str(item[1]).strip()]
        return "\n".join(lines)
    except Exception:
        return ""


def _chunk_text(text: str, max_chars: int = 700, overlap: int = 100) -> list[str]:
    clean = " ".join(text.split()).strip()
    if not clean:
        return []
    if len(clean) <= max_chars:
        return [clean]
    chunks: list[str] = []
    start = 0
    while start < len(clean):
        end = min(len(clean), start + max_chars)
        chunks.append(clean[start:end].strip())
        if end >= len(clean):
            break
        start = max(end - overlap, start + 1)
    return chunks


def _fmt_rp(val: Any) -> str:
    if val is None:
        return "belum tersedia"
    try:
        n = float(val)
    except (TypeError, ValueError):
        return "Rp 0"
    if abs(n) >= 1e12:
        return f"Rp {n / 1e12:,.2f} Triliun"
    if abs(n) >= 1e9:
        return f"Rp {n / 1e9:,.2f} Miliar"
    if abs(n) >= 1e6:
        return f"Rp {n / 1e6:,.1f} Juta"
    return f"Rp {n:,.0f}"


def _build_chunks_for_table(full_name: str, arrow: pa.Table) -> list[dict[str, str]]:
    layer = full_name.split(".", 1)[0]
    rows = arrow.to_pylist()
    out: list[dict[str, str]] = []

    if full_name == "gold.apbd_opd_summary":
        for r in rows:
            pct = r.get("serapan_sp2d_pct")
            txt = (
                f"Ringkasan APBD Perangkat Daerah {r.get('nama_opd', '')}: "
                f"Total Alokasi {_fmt_rp(r.get('alokasi_rp'))}, "
                f"Total Realisasi {_fmt_rp(r.get('total_realisasi_rp'))}, "
                f"SP2D {_fmt_rp(r.get('sp2d_rp'))} ({'belum tersedia' if pct is None else f'{pct}%'}), "
                f"Sub-kegiatan: {r.get('jumlah_sub_kegiatan', 0)}, "
                f"Paket pekerjaan: {r.get('jumlah_pekerjaan', 0)}, "
                f"Temuan anomali kualitas data: {r.get('jumlah_anomali', 0)}."
            )
            out.append({"source": full_name, "layer": layer, "text": txt})
        return out

    if full_name == "gold.apbd_tematik_prioritas":
        for r in rows:
            txt = (
                f"Anggaran Tematik Prioritas {r.get('tema', '')}: "
                f"Total {_fmt_rp(r.get('total_rp'))} mencakup {r.get('komponen', 0)} komponen belanja eBudgeting."
            )
            out.append({"source": full_name, "layer": layer, "text": txt})
        return out

    if full_name == "gold.apbd_subkegiatan_summary":
        for r in rows:
            sp2d_part = (
                f", SP2D {_fmt_rp(r.get('total_sp2d_rp'))}" if r.get("total_sp2d_rp") is not None else ""
            )
            extra = (
                f" Sumber dana: {r.get('sumber_dana')}." if r.get("sumber_dana") else ""
            ) + (
                f" Subtitle: {r.get('daftar_subtitle')}." if r.get("daftar_subtitle") else ""
            )
            txt = (
                f"Sub Kegiatan {r.get('kode_sub_kegiatan', '')} ({r.get('nama_opd', '')}): "
                f"{r.get('nama_sub_kegiatan', '')} — Total Anggaran {_fmt_rp(r.get('total_anggaran_rp'))}{sp2d_part}.{extra}"
            )
            out.append({"source": full_name, "layer": layer, "text": txt[:700]})
        return out

    if full_name == "gold.ebudgeting_curated":
        for r in rows:
            detil = f" ({r.get('nama_detil')})" if r.get("nama_detil") else ""
            txt = (
                f"[eBudgeting {r.get('tahap', '')} · {r.get('nama_opd', '')}] "
                f"{r.get('nama_sub_kegiatan', '')} › {r.get('nama_subtitle', '')} › "
                f"{r.get('nama_komponen', '')}{detil}: "
                f"Volume {r.get('koefisien') or r.get('volume')} × {_fmt_rp(r.get('harga_satuan_rp'))} = "
                f"{_fmt_rp(r.get('hasil_rp'))} | Sumber Dana: {r.get('sumber_dana', '')} | Rekening: {r.get('nama_rekening', '')}"
            )
            out.append({"source": full_name, "layer": layer, "text": txt[:700]})
        return out

    col_names = set(arrow.schema.names)

    if "text_excerpt" in col_names:
        for r in rows:
            fname = r.get("source_file", "dokumen.pdf")
            pg = r.get("page_number", 1)
            excerpt = str(r.get("text_excerpt") or "").strip()
            for part in _chunk_text(excerpt):
                out.append({"source": full_name, "layer": layer, "text": f"[PDF {fname} hal.{pg}] {part}"})
        return out

    if "ocr_text" in col_names:
        for r in rows:
            fname = r.get("source_file", "gambar")
            ocr_txt = str(r.get("ocr_text") or "").strip()
            parts = [f"[Gambar OCR {fname}] {part}" for part in _chunk_text(ocr_txt)] or [
                f"[Gambar {fname}] Berkas gambar tersimpan ({r.get('size_bytes', 0)} bytes), tidak ada teks terbaca."
            ]
            out.extend({"source": full_name, "layer": layer, "text": text} for text in parts)
        return out

    if "link_href" in col_names:
        for r in rows:
            title = str(r.get("page_title") or "").strip()
            label = str(r.get("link_text") or "").strip()
            href = str(r.get("link_href") or "").strip()
            src_url = str(r.get("source_url") or "").strip()
            txt = f"[Web {title}] {label} — Tautan: {href} (Sumber: {src_url})"
            out.append({"source": full_name, "layer": layer, "text": txt[:700]})
        return out

    # Generic table (CSV, XLSX, Gold custom summary, etc.)
    for r in rows:
        pairs = [
            f"{k}: {v}"
            for k, v in r.items()
            if not k.startswith("_") and v not in (None, "", 0, False)
        ]
        if not pairs:
            continue
        txt = f"[{full_name}] " + " | ".join(pairs)
        out.append({"source": full_name, "layer": layer, "text": txt[:700]})
    return out


def _read_existing_vectors() -> list[dict[str, Any]]:
    if not VECTOR_STORE_PATH.exists():
        return []
    try:
        tbl = pq.read_table(VECTOR_STORE_PATH)
        return tbl.to_pylist()
    except Exception:
        return []


def _write_vectors(records: list[dict[str, Any]]) -> None:
    ensure_warehouse()
    schema = pa.schema(
        [
            ("chunk_id", pa.string()),
            ("source", pa.string()),
            ("layer", pa.string()),
            ("text", pa.string()),
            ("embedding", pa.list_(pa.float32())),
        ]
    )
    if not records:
        tbl = pa.Table.from_pylist([], schema=schema)
    else:
        tbl = pa.Table.from_pylist(records, schema=schema)
    tmp = VECTOR_STORE_PATH.with_suffix(".tmp")
    pq.write_table(tbl, tmp)
    os.replace(tmp, VECTOR_STORE_PATH)


def _embed_chunks(chunks: list[dict[str, str]]) -> list[dict[str, Any]]:
    if not chunks:
        return []
    texts = [c["text"] for c in chunks]
    vectors = list(_get_embedder().embed(texts, batch_size=EMBED_BATCH_SIZE))
    records: list[dict[str, Any]] = []
    for i, (c, vec) in enumerate(zip(chunks, vectors)):
        cid = hashlib.sha256(f"{c['source']}::{i}::{c['text']}".encode("utf-8")).hexdigest()[:16]
        records.append(
            {
                "chunk_id": cid,
                "source": c["source"],
                "layer": c["layer"],
                "text": c["text"],
                "embedding": [float(x) for x in vec],
            }
        )
    return records


def index_table_to_vectors(full_name: str) -> dict[str, Any]:
    """Build or refresh local vector embeddings for a single Gold Iceberg table."""
    if not full_name.startswith("gold."):
        raise ValueError("Hanya tabel pada layer Gold (gold.*) yang boleh di-vectorize. Promosikan ke Gold terlebih dahulu.")
    with _VECTOR_LOCK:
        t0 = time.perf_counter()
        catalog = get_catalog()
        arrow = _read_table_arrow(catalog, full_name)
        if arrow is None:
            raise ValueError(f"Tabel {full_name} tidak ditemukan.")

        chunks = _build_chunks_for_table(full_name, arrow)
        new_records = _embed_chunks(chunks)

        existing = [
            r
            for r in _read_existing_vectors()
            if r.get("source") != full_name and str(r.get("source") or "").startswith("gold.")
        ]
        merged = existing + new_records
        _write_vectors(merged)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "status": "indexed",
            "table": full_name,
            "chunksAdded": len(new_records),
            "totalChunks": len(merged),
            "elapsedMs": elapsed_ms,
            "model": EMBED_MODEL_NAME,
        }


EXCLUDED_AUTO_VECTOR_TABLES = {"gold.dq_anomaly_audit"}


def rebuild_all_vectors() -> dict[str, Any]:
    """Index ONLY curated Gold Iceberg tables into the local vector store."""
    with _VECTOR_LOCK:
        t0 = time.perf_counter()
        catalog = get_catalog()

        all_chunks: list[dict[str, str]] = []
        indexed_tables: list[str] = []

        for _, tbl_name in catalog.list_tables("gold"):
            full_name = f"gold.{tbl_name}"
            if full_name in EXCLUDED_AUTO_VECTOR_TABLES:
                continue
            arrow = _read_table_arrow(catalog, full_name)
            if arrow is None or arrow.num_rows == 0:
                continue
            chunks = _build_chunks_for_table(full_name, arrow)
            if chunks:
                all_chunks.extend(chunks)
                indexed_tables.append(full_name)

        records = _embed_chunks(all_chunks)
        _write_vectors(records)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        return {
            "status": "rebuilt",
            "tablesIndexed": indexed_tables,
            "totalChunks": len(records),
            "elapsedMs": elapsed_ms,
            "model": EMBED_MODEL_NAME,
        }


KEYWORD_WEIGHT = 0.5


def _keyword_scores(query: str, texts: list[str]) -> np.ndarray:
    """Share of the query's words (rare words count more) that appear in each text, from 0 to 1.

    Pure meaning-search lets 10,000 budget rows drown a single uploaded PDF or image.
    """
    lowered = [t.lower() for t in texts]
    words = {w for w in re.findall(r"\w{3,}", query.lower())}
    hits = {w: np.fromiter((w in t for t in lowered), dtype=bool, count=len(lowered)) for w in words}
    weights = {w: np.log((len(lowered) + 1) / (h.sum() + 1)) for w, h in hits.items()}
    total = sum(weights.values())
    if not total:
        return np.zeros(len(lowered), dtype=np.float32)
    return (sum(weights[w] * hits[w] for w in hits) / total).astype(np.float32)


def search_vectors(query: str, top_k: int = 6) -> dict[str, Any]:
    """Cosine similarity search over the local Parquet vector store."""
    q = query.strip()
    if not q:
        return {"query": "", "results": [], "elapsedMs": 0}
    t0 = time.perf_counter()
    table = pq.read_table(VECTOR_STORE_PATH) if VECTOR_STORE_PATH.exists() else None
    if table is None or table.num_rows == 0:
        return {"query": q, "results": [], "elapsedMs": 0, "empty": True}

    q_vec = np.asarray(list(_get_embedder().embed([q]))[0], dtype=np.float32)
    # Read the embeddings straight into numpy; converting to Python lists is slow at this size.
    flat = table.column("embedding").combine_chunks().flatten().to_numpy(zero_copy_only=False)
    mat = flat.reshape(table.num_rows, -1)

    # Normalized hybrid score in [0, 1]: cosine similarity + rare-word keyword boost
    q_norm = np.linalg.norm(q_vec) + 1e-10
    m_norms = np.linalg.norm(mat, axis=1) + 1e-10
    cos = np.clip((mat @ q_vec) / (m_norms * q_norm), 0.0, 1.0)
    kw = _keyword_scores(q, table.column("text").to_pylist())
    scores = (cos + KEYWORD_WEIGHT * kw) / (1.0 + KEYWORD_WEIGHT)

    k = min(max(1, top_k), table.num_rows)
    top_idx = np.argsort(scores)[::-1][:k]
    hits = table.take(pa.array(top_idx)).select(["chunk_id", "source", "layer", "text"]).to_pylist()
    results = [
        {
            "chunkId": hit["chunk_id"],
            "source": hit["source"],
            "layer": hit["layer"],
            "score": round(float(scores[int(i)]), 4),
            "text": hit["text"],
        }
        for i, hit in zip(top_idx, hits)
    ]
    return {
        "query": q,
        "model": EMBED_MODEL_NAME,
        "totalChunks": table.num_rows,
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
        "results": results,
    }


def get_vector_stats() -> dict[str, Any]:
    catalog = get_catalog()
    active_gold = {f"gold.{t}" for _, t in catalog.list_tables("gold")}
    records = _read_existing_vectors()
    # Auto-prune stale vectors from dropped Gold tables
    if any(str(r.get("source") or "") not in active_gold for r in records):
        with _VECTOR_LOCK:  # read again inside the lock so a running index job is not overwritten
            active_gold = {f"gold.{t}" for _, t in catalog.list_tables("gold")}
            records = [r for r in _read_existing_vectors() if str(r.get("source") or "") in active_gold]
            _write_vectors(records)

    by_source: dict[str, dict[str, Any]] = {}
    for r in records:
        src = str(r.get("source") or "unknown")
        if src not in by_source:
            by_source[src] = {"source": src, "layer": r.get("layer", "gold"), "chunks": 0}
        by_source[src]["chunks"] += 1
    size_kb = round(VECTOR_STORE_PATH.stat().st_size / 1024, 1) if VECTOR_STORE_PATH.exists() else 0.0
    return {
        "totalChunks": len(records),
        "sizeKb": size_kb,
        "model": EMBED_MODEL_NAME,
        "sources": sorted(by_source.values(), key=lambda x: -x["chunks"]),
    }


def remove_table_vectors(full_name: str) -> None:
    with _VECTOR_LOCK:
        records = _read_existing_vectors()
        filtered = [r for r in records if r.get("source") != full_name]
        if len(filtered) != len(records):
            _write_vectors(filtered)
