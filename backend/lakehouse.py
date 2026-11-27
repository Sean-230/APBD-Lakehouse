from __future__ import annotations

import csv
import functools
import hashlib
import io
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import duckdb
import httpx
import openpyxl
import pdfplumber
import pyarrow as pa
from bs4 import BeautifulSoup
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.expressions import In

ROOT_DIR = Path(__file__).resolve().parent.parent
WAREHOUSE_DIR = ROOT_DIR / "warehouse"
ICEBERG_DIR = WAREHOUSE_DIR / "iceberg"
RAW_DIR = WAREHOUSE_DIR / "raw"
CATALOG_DB = WAREHOUSE_DIR / "catalog.db"
INGEST_LOG_PATH = WAREHOUSE_DIR / "ingest_log.json"

NAMESPACES = ("bronze", "silver", "gold")
# shortcut: in-process lock, so run a single uvicorn worker; use catalog-level locking for more.
_WAREHOUSE_LOCK = threading.RLock()

WIB = timezone(timedelta(hours=7))
SQL_TIMEOUT_S = 30
SQL_MAX_ROWS = 500
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


class StaleTableError(ValueError):
    """The table changed after the caller read it, so row positions are no longer valid."""


def _locked(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _WAREHOUSE_LOCK:
            return fn(*args, **kwargs)

    return wrapper


def _validate_readonly_sql(query: str) -> str:
    """Allow exactly one read statement, as judged by DuckDB's own parser."""
    q = query.strip().rstrip(";").strip()
    try:
        statements = duckdb.extract_statements(q)
    except duckdb.Error as exc:
        raise ValueError(f"SQL tidak valid: {exc}") from exc
    if len(statements) != 1 or statements[0].type.name not in ("SELECT", "EXPLAIN"):
        raise ValueError("Hanya 1 query baca (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) yang diizinkan.")
    return q


def _validate_public_url(url: str) -> None:
    """Block SSRF attempts targeting localhost, loopback, or private/link-local networks."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL tidak valid. Harus diawali http:// atau https://")
    host = parsed.hostname.lower()
    if host in ("localhost", "localhost.localdomain") or host.endswith(".local"):
        raise ValueError("Akses ke host lokal/internal diblokir demi keamanan.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ValueError(f"Host tidak dapat ditemukan: {host}") from exc
    # shortcut: DNS can change between this check and the fetch; pin the resolved IP if that matters.
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise ValueError(f"Akses ke alamat jaringan internal ({ip}) diblokir.")


def _now_iso() -> str:
    return datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S WIB")


def _fmt_ms(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, tz=WIB).strftime("%Y-%m-%d %H:%M WIB")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sanitize_ident(name: str) -> str:
    stem = Path(name).stem.lower()
    cleaned = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return cleaned[:48] or "dataset"


def _to_float(val: Any) -> float | None:
    """Parse Indonesian (1.500.000,50) and English (1,500,000.50) numbers. Empty or "-" is None."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace("Rp", "").replace(" ", "").replace("\u00a0", "").rstrip("%")
    if s in ("", "-"):
        return None
    if re.fullmatch(r"-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?", s):
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"-?[1-9]\d{0,2}((,\d{3}){2,}(\.\d+)?|(,\d{3})+\.\d+)", s):
        s = s.replace(",", "")
    elif re.fullmatch(r"-?\d+,\d+", s):
        s = s.replace(",", ".")
    try:
        number = float(s)
    except ValueError:
        number = math.nan
    if not math.isfinite(number):
        raise ValueError(f"Angka tidak terbaca: {val!r}")
    return number


def _to_int(val: Any) -> int | None:
    f = _to_float(val)
    return int(round(f)) if f is not None else None


def _to_bool(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return val != 0
    return str(val).strip().lower() in ("1", "true", "ya", "yes", "y")


def _parse_fisik_real(val: Any) -> float:
    """Parse values like '84.10 (100.00)' or numeric percentages into float."""
    if val is None or val == "":
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    m = re.search(r"-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:[.,]\d+)?", str(val))
    if not m:
        return 0.0
    number = m.group(0)
    if re.fullmatch(r"-?\d{1,3}(,\d{3})+(\.\d+)?", number):
        return float(number.replace(",", ""))
    return float(number.replace(",", "."))


def ensure_warehouse() -> None:
    WAREHOUSE_DIR.mkdir(parents=True, exist_ok=True)
    ICEBERG_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if not INGEST_LOG_PATH.exists():
        INGEST_LOG_PATH.write_text("[]", encoding="utf-8")


def get_catalog() -> SqlCatalog:
    ensure_warehouse()
    catalog = SqlCatalog(
        "suralake",
        **{
            "uri": f"sqlite:///{CATALOG_DB}",
            "warehouse": f"file://{ICEBERG_DIR}",
        },
    )
    existing = {ns[0] for ns in catalog.list_namespaces()}
    for ns in NAMESPACES:
        if ns not in existing:
            catalog.create_namespace(ns)
    return catalog


def read_ingest_logs() -> list[dict[str, Any]]:
    ensure_warehouse()
    try:
        return json.loads(INGEST_LOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def append_ingest_log(entry: dict[str, Any]) -> None:
    with _WAREHOUSE_LOCK:
        logs = read_ingest_logs()
        logs.insert(0, entry)
        tmp = INGEST_LOG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, INGEST_LOG_PATH)


def _drop_stale_vectors(identifier: str) -> None:
    """A changed Gold table must be re-indexed, so old search text is never served."""
    if identifier.startswith("gold."):
        from vector_store import remove_table_vectors

        remove_table_vectors(identifier)


def _write_iceberg_table(
    catalog: SqlCatalog,
    identifier: str,
    arrow_table: pa.Table,
    mode: str = "overwrite",
    key: str | None = None,
) -> dict[str, Any]:
    """Create or write a PyArrow table into Iceberg.

    mode "replace" swaps only the rows whose `key` value appears in the new data.
    """
    with _WAREHOUSE_LOCK:
        tbl = catalog.load_table(identifier) if catalog.table_exists(identifier) else None
        if tbl is not None:
            existing_cols = [f.name for f in tbl.schema().fields]
            incoming_cols = list(arrow_table.schema.names)
            if mode == "replace":
                if set(incoming_cols) - set(existing_cols):
                    with tbl.update_schema() as update:
                        update.union_by_name(arrow_table.schema)
                    tbl = catalog.load_table(identifier)
                values = set(arrow_table.column(key).to_pylist())
                tbl.overwrite(arrow_table, overwrite_filter=In(key, values))
            elif existing_cols != incoming_cols:
                tbl = None
            elif identifier.startswith("gold.") and tbl.scan().to_arrow().to_pylist() == arrow_table.to_pylist():
                snap = tbl.current_snapshot()
                return {"table": identifier, "rows": arrow_table.num_rows, "snapshot_id": str(snap.snapshot_id) if snap else None}
            else:
                try:
                    tbl.overwrite(arrow_table)
                except ValueError:  # same column names, different types
                    tbl = None
            if tbl is None:
                catalog.drop_table(identifier)
        if tbl is None:
            tbl = catalog.create_table(identifier, schema=arrow_table.schema)
            tbl.append(arrow_table)
        _drop_stale_vectors(identifier)

        snap = tbl.current_snapshot()
        return {
            "table": identifier,
            "rows": arrow_table.num_rows,
            "snapshot_id": str(snap.snapshot_id) if snap else None,
        }


def _read_table_arrow(catalog: SqlCatalog, identifier: str) -> pa.Table | None:
    if not catalog.table_exists(identifier):
        return None
    tbl = catalog.load_table(identifier)
    return tbl.scan().to_arrow()


# ---------- PARSERS & MEDALLION TRANSFORMERS ----------

def _parse_sub_kegiatan_id(raw: Any) -> tuple[str, int | None]:
    if raw is None:
        return ("", None)
    s = str(raw).strip()
    internal_id = None
    m = re.search(r"\((\d+)\)\s*$", s)
    if m:
        internal_id = int(m.group(1))
        s = s[: m.start()].strip()
    std = re.sub(r"\s+", ".", s)
    return (std, internal_id)


def _split_sub_kegiatan_ppkm(raw: Any) -> tuple[str, str]:
    if raw is None:
        return ("", "")
    s = str(raw).strip()
    m = re.search(r"\(PPKm:\s*(.+?)\)\s*$", s, flags=re.IGNORECASE)
    if m:
        return (s[: m.start()].strip(), m.group(1).strip())
    return (s, "")


def _rebuild_gold_layers(catalog: SqlCatalog) -> list[dict[str, Any]]:
    """Compute Gold data marts from Silver Iceberg tables using DuckDB."""
    results: list[dict[str, Any]] = []
    mon_arrow = _read_table_arrow(catalog, "silver.monitoring_pekerjaan")
    eb_arrow = _read_table_arrow(catalog, "silver.ebudgeting_rincian")

    con = duckdb.connect()
    try:
        if mon_arrow is not None:
            con.register("silver_mon", mon_arrow)
            opd_summary = con.sql(
                """
                SELECT
                    nama_opd,
                    COUNT(DISTINCT kode_sub_kegiatan) AS jumlah_sub_kegiatan,
                    COUNT(*) AS jumlah_pekerjaan,
                    COALESCE(SUM(alokasi_rp), 0)::BIGINT AS alokasi_rp,
                    COALESCE(SUM(penggunaan_dana_rp), 0)::BIGINT AS penggunaan_dana_rp,
                    COALESCE(SUM(total_realisasi_rp), 0)::BIGINT AS total_realisasi_rp,
                    COALESCE(SUM(sp2d_rp), 0)::BIGINT AS sp2d_rp,
                    CASE
                        WHEN COALESCE(SUM(alokasi_rp), 0) > 0
                        THEN ROUND(COALESCE(SUM(sp2d_rp), 0) * 100.0 / SUM(alokasi_rp), 2)
                        ELSE 0.0
                    END AS serapan_sp2d_pct,
                    SUM(CASE WHEN dq_flag <> '' THEN 1 ELSE 0 END)::BIGINT AS jumlah_anomali
                FROM silver_mon
                WHERE nama_opd IS NOT NULL AND nama_opd <> ''
                GROUP BY nama_opd
                ORDER BY alokasi_rp DESC
                """
            ).to_arrow_table()
            results.append(_write_iceberg_table(catalog, "gold.apbd_opd_summary", opd_summary, mode="overwrite"))

            real_fisik_expr = (
                "realisasi_fisik_pct"
                if "realisasi_fisik_pct" in mon_arrow.schema.names
                else "NULL::DOUBLE AS realisasi_fisik_pct"
            )
            anomalies = con.sql(
                f"""
                SELECT
                    nama_opd,
                    kode_sub_kegiatan,
                    id_pekerjaan,
                    nama_pekerjaan,
                    alokasi_rp,
                    penggunaan_dana_rp,
                    sp2d_rp,
                    GREATEST(alokasi_rp, penggunaan_dana_rp)::BIGINT AS pagu_efektif_rp,
                    (sp2d_rp - GREATEST(alokasi_rp, penggunaan_dana_rp))::BIGINT AS selisih_overbudget_rp,
                    rencana_fisik_pct,
                    {real_fisik_expr},
                    dq_flag
                FROM silver_mon
                WHERE dq_flag <> ''
                ORDER BY
                    CASE WHEN dq_flag LIKE '%OVERBUDGET%' THEN 0 ELSE 1 END,
                    (sp2d_rp - GREATEST(alokasi_rp, penggunaan_dana_rp)) DESC,
                    sp2d_rp DESC
                """
            ).to_arrow_table()
            results.append(_write_iceberg_table(catalog, "gold.dq_anomaly_audit", anomalies, mode="overwrite"))

            # Expose curated sub-kegiatan summary from Monitoring when eBudgeting is not loaded
            if eb_arrow is None:
                mon_sub = con.sql(
                    """
                    SELECT
                        nama_opd,
                        kode_sub_kegiatan,
                        nama_sub_kegiatan,
                        COUNT(*)::BIGINT AS jumlah_pekerjaan,
                        COALESCE(SUM(alokasi_rp), 0)::BIGINT AS total_anggaran_rp,
                        COALESCE(SUM(penggunaan_dana_rp), 0)::BIGINT AS total_penggunaan_dana_rp,
                        COALESCE(SUM(sp2d_rp), 0)::BIGINT AS total_sp2d_rp
                    FROM silver_mon
                    WHERE nama_opd IS NOT NULL AND nama_opd <> ''
                    GROUP BY nama_opd, kode_sub_kegiatan, nama_sub_kegiatan
                    ORDER BY total_anggaran_rp DESC
                    """
                ).to_arrow_table()
                results.append(_write_iceberg_table(catalog, "gold.apbd_subkegiatan_summary", mon_sub, mode="overwrite"))

        if eb_arrow is not None:
            con.register("silver_eb_t", eb_arrow)
            # Use the PAK stage for every OPD that has one; an OPD without PAK keeps all its rows.
            con.execute(
                """
                CREATE VIEW eb_scoped AS SELECT * FROM silver_eb_t
                WHERE LOWER(tahap) = 'pak' OR nama_opd NOT IN (
                    SELECT nama_opd FROM silver_eb_t WHERE LOWER(tahap) = 'pak'
                )
                """
            )

        if mon_arrow is None and eb_arrow is not None:
            # No monitoring data: spending is unknown (NULL), which is different from zero.
            opd_summary = con.sql(
                """
                SELECT
                    nama_opd,
                    COUNT(DISTINCT kode_sub_kegiatan) AS jumlah_sub_kegiatan,
                    COUNT(*) AS jumlah_pekerjaan,
                    COALESCE(SUM(hasil_rp), 0)::BIGINT AS alokasi_rp,
                    COALESCE(SUM(anggaran_rasionalisasi_rp), 0)::BIGINT AS penggunaan_dana_rp,
                    NULL::BIGINT AS total_realisasi_rp,
                    NULL::BIGINT AS sp2d_rp,
                    NULL::DOUBLE AS serapan_sp2d_pct,
                    0::BIGINT AS jumlah_anomali
                FROM eb_scoped
                WHERE nama_opd IS NOT NULL AND nama_opd <> ''
                GROUP BY nama_opd
                ORDER BY alokasi_rp DESC
                """
            ).to_arrow_table()
            results.append(_write_iceberg_table(catalog, "gold.apbd_opd_summary", opd_summary, mode="overwrite"))

        if eb_arrow is not None:
            # 1. Full curated Gold detail table (preserves all PAK/active rows & detail columns for BI, SQL, & Chatbot)
            eb_curated = con.sql(
                """
                SELECT
                    nama_opd,
                    kode_detail_kegiatan,
                    kode_sub_kegiatan,
                    nama_sub_kegiatan,
                    nama_subtitle,
                    nama_komponen,
                    nama_detil,
                    satuan,
                    volume,
                    koefisien,
                    harga_satuan_rp,
                    pajak_pct,
                    hasil_rp,
                    anggaran_rasionalisasi_rp,
                    sumber_dana,
                    rekening,
                    nama_rekening,
                    tahap,
                    is_pendidikan,
                    is_kesehatan,
                    is_infrastruktur,
                    is_stunting,
                    is_miskin,
                    is_inflasi
                FROM eb_scoped
                ORDER BY hasil_rp DESC
                """
            ).to_arrow_table()
            results.append(_write_iceberg_table(catalog, "gold.ebudgeting_curated", eb_curated, mode="overwrite"))

            # 2. Sub-kegiatan summary mart: preserve ALL OPDs from Monitoring and enrich with eBudgeting PAK details
            if mon_arrow is not None:
                unified_sub = con.sql(
                    """
                    WITH mon_sub AS (
                        SELECT
                            LOWER(TRIM(nama_opd)) AS opd_key,
                            TRIM(kode_sub_kegiatan) AS kode_key,
                            ANY_VALUE(nama_opd) AS nama_opd,
                            ANY_VALUE(kode_sub_kegiatan) AS kode_sub_kegiatan,
                            ANY_VALUE(nama_sub_kegiatan) AS nama_sub_kegiatan,
                            COUNT(*)::BIGINT AS jumlah_pekerjaan,
                            COALESCE(SUM(alokasi_rp), 0)::BIGINT AS total_anggaran_rp,
                            COALESCE(SUM(penggunaan_dana_rp), 0)::BIGINT AS total_penggunaan_dana_rp,
                            COALESCE(SUM(sp2d_rp), 0)::BIGINT AS total_sp2d_rp
                        FROM silver_mon
                        WHERE nama_opd IS NOT NULL AND nama_opd <> ''
                        GROUP BY LOWER(TRIM(nama_opd)), TRIM(kode_sub_kegiatan)
                    ),
                    eb_sub AS (
                        SELECT
                            LOWER(TRIM(nama_opd)) AS opd_key,
                            TRIM(kode_sub_kegiatan) AS kode_key,
                            ANY_VALUE(nama_opd) AS nama_opd,
                            ANY_VALUE(kode_sub_kegiatan) AS kode_sub_kegiatan,
                            ANY_VALUE(nama_sub_kegiatan) AS nama_sub_kegiatan,
                            COUNT(*)::BIGINT AS jumlah_komponen,
                            COALESCE(SUM(hasil_rp), 0)::BIGINT AS total_ebudgeting_rp,
                            STRING_AGG(DISTINCT NULLIF(sumber_dana, ''), ', ') AS sumber_dana,
                            STRING_AGG(DISTINCT NULLIF(nama_subtitle, ''), '; ') AS daftar_subtitle
                        FROM eb_scoped
                        WHERE nama_opd IS NOT NULL AND nama_opd <> ''
                        GROUP BY LOWER(TRIM(nama_opd)), TRIM(kode_sub_kegiatan)
                    )
                    SELECT
                        COALESCE(m.nama_opd, e.nama_opd) AS nama_opd,
                        COALESCE(m.kode_sub_kegiatan, e.kode_sub_kegiatan) AS kode_sub_kegiatan,
                        COALESCE(NULLIF(m.nama_sub_kegiatan, ''), e.nama_sub_kegiatan) AS nama_sub_kegiatan,
                        COALESCE(m.jumlah_pekerjaan, 0)::BIGINT AS jumlah_pekerjaan,
                        COALESCE(e.jumlah_komponen, 0)::BIGINT AS jumlah_komponen,
                        COALESCE(m.total_anggaran_rp, e.total_ebudgeting_rp, 0)::BIGINT AS total_anggaran_rp,
                        m.total_penggunaan_dana_rp,
                        m.total_sp2d_rp,
                        e.total_ebudgeting_rp,
                        COALESCE(e.sumber_dana, '') AS sumber_dana,
                        COALESCE(e.daftar_subtitle, '') AS daftar_subtitle
                    FROM mon_sub m
                    FULL OUTER JOIN eb_sub e
                        ON m.opd_key = e.opd_key AND m.kode_key = e.kode_key
                    ORDER BY total_anggaran_rp DESC
                    """
                ).to_arrow_table()
                results.append(_write_iceberg_table(catalog, "gold.apbd_subkegiatan_summary", unified_sub, mode="overwrite"))
            else:
                eb_sub = con.sql(
                    """
                    SELECT
                        nama_opd,
                        kode_sub_kegiatan,
                        nama_sub_kegiatan,
                        COUNT(*)::BIGINT AS jumlah_komponen,
                        COALESCE(SUM(hasil_rp), 0)::BIGINT AS total_anggaran_rp,
                        STRING_AGG(DISTINCT NULLIF(sumber_dana, ''), ', ') AS sumber_dana,
                        STRING_AGG(DISTINCT NULLIF(nama_subtitle, ''), '; ') AS daftar_subtitle
                    FROM eb_scoped
                    GROUP BY nama_opd, kode_sub_kegiatan, nama_sub_kegiatan
                    ORDER BY total_anggaran_rp DESC
                    """
                ).to_arrow_table()
                results.append(_write_iceberg_table(catalog, "gold.apbd_subkegiatan_summary", eb_sub, mode="overwrite"))

            # 3. Thematic priority mart
            tematik = con.sql(
                """
                SELECT 'Pendidikan' AS tema, COUNT(*) AS komponen, COALESCE(SUM(hasil_rp), 0)::BIGINT AS total_rp FROM eb_scoped WHERE is_pendidikan
                UNION ALL
                SELECT 'Kesehatan', COUNT(*), COALESCE(SUM(hasil_rp), 0)::BIGINT FROM eb_scoped WHERE is_kesehatan
                UNION ALL
                SELECT 'Infrastruktur', COUNT(*), COALESCE(SUM(hasil_rp), 0)::BIGINT FROM eb_scoped WHERE is_infrastruktur
                UNION ALL
                SELECT 'Stunting', COUNT(*), COALESCE(SUM(hasil_rp), 0)::BIGINT FROM eb_scoped WHERE is_stunting
                UNION ALL
                SELECT 'Kemiskinan', COUNT(*), COALESCE(SUM(hasil_rp), 0)::BIGINT FROM eb_scoped WHERE is_miskin
                UNION ALL
                SELECT 'Inflasi', COUNT(*), COALESCE(SUM(hasil_rp), 0)::BIGINT FROM eb_scoped WHERE is_inflasi
                """
            ).to_arrow_table()
            results.append(_write_iceberg_table(catalog, "gold.apbd_tematik_prioritas", tematik, mode="overwrite"))
    finally:
        con.close()

    return results


def _ingest_monitoring_excel(
    catalog: SqlCatalog, ws: Any, filename: str, sha256: str, ingested_at: str
) -> dict[str, Any]:
    rows_raw: list[dict[str, Any]] = []
    periode = ""

    for idx, row in enumerate(ws.iter_rows(values_only=True)):
        if idx == 0 and row and row[0]:
            periode = str(row[0]).strip()
            continue
        if idx < 5:
            continue
        if not row or not any(row):
            continue

        # Pad to 24 columns safely
        r = list(row) + [None] * max(0, 24 - len(row))
        pd_name = str(r[0]).strip() if r[0] is not None else ""
        if not pd_name:
            continue

        id_sub_raw = str(r[1]).strip() if r[1] is not None else ""
        nama_sub_raw = str(r[2]).strip() if r[2] is not None else ""
        alokasi = _to_int(r[10]) or 0
        penggunaan = _to_int(r[11]) or 0
        renc_fisik = _to_float(r[12]) or 0.0
        prog_real_rp = _to_int(r[13]) or 0
        prog_real_pct = _to_float(r[14]) or 0.0
        real_fisik = _parse_fisik_real(r[15])
        tot_real = _to_int(r[16]) or 0
        sp2d = _to_int(r[17]) or 0
        nilai_kontrak = _to_int(r[23]) or 0

        rows_raw.append(
            {
                "perangkat_daerah": pd_name,
                "id_sub_kegiatan_raw": id_sub_raw,
                "nama_sub_kegiatan_raw": nama_sub_raw,
                "id_pakerjaan": str(r[3]) if r[3] is not None else "",
                "nama_pakerjaan": str(r[4]).strip() if r[4] is not None else "",
                "metode_pekerjaan": str(r[9]).strip() if r[9] is not None else "",
                "alokasi_rp": alokasi,
                "penggunaan_dana_rp": penggunaan,
                "rencana_fisik_pct": renc_fisik,
                "progress_realisasi_rp": prog_real_rp,
                "progress_realisasi_pct": prog_real_pct,
                "realisasi_fisik_pct": real_fisik,
                "total_realisasi_rp": tot_real,
                "sp2d_rp": sp2d,
                "nomor_kontrak": str(r[18]).strip() if r[18] is not None else "",
                "rekanan": str(r[22]).strip() if r[22] is not None else "",
                "nilai_kontrak_rp": nilai_kontrak,
                "_periode_raw": periode,
                "_source_file": filename,
                "_sha256": sha256[:12],
                "_ingested_at": ingested_at,
            }
        )

    if not rows_raw:
        raise ValueError("File Monitoring tidak memiliki baris data yang valid.")
    bronze_res = _write_iceberg_table(
        catalog, "bronze.monitoring_pd_raw", pa.Table.from_pylist(rows_raw), mode="overwrite"
    )
    return {
        "detected": "monitoring_semua_pd",
        "target_table": "bronze.monitoring_pd_raw",
        "rows_extracted": len(rows_raw),
        "status": "Committed",
        "layers_written": [bronze_res],
    }


def _ingest_ebudgeting_excel(
    catalog: SqlCatalog, ws: Any, filename: str, sha256: str, ingested_at: str
) -> dict[str, Any]:
    rows_iter = ws.iter_rows(values_only=True)
    headers = [str(h).strip() if h is not None else f"col_{i}" for i, h in enumerate(next(rows_iter))]
    h_idx = {h: i for i, h in enumerate(headers)}

    def get(row: tuple[Any, ...], col: str) -> Any:
        i = h_idx.get(col)
        return row[i] if i is not None and i < len(row) else None

    rows_raw: list[dict[str, Any]] = []

    for row in rows_iter:
        if not row or not any(row):
            continue
        skpd = str(get(row, "nama_skpd") or "").strip()
        kegiatan_id = str(get(row, "kegiatan_id") or "").strip()
        hasil_rp = _to_int(get(row, "hasil")) or 0
        rasio_rp = _to_int(get(row, "anggaran_rasionalisasi")) or 0
        harga = _to_int(get(row, "harga_satuan")) or 0
        vol = _to_float(get(row, "volume")) or 0.0

        rows_raw.append(
            {
                "id_skpd": str(get(row, "id_skpd") or ""),
                "nama_skpd": skpd,
                "kode_detail_kegiatan": str(get(row, "kode_detail_kegiatan") or ""),
                "kode_sub_kegiatan": str(get(row, "kode_sub_kegiatan") or ""),
                "kegiatan_id": kegiatan_id,
                "nama_sub_kegiatan": str(get(row, "nama_sub_kegiatan") or ""),
                "kode_subtitle": str(get(row, "kode_subtitle") or ""),
                "nama_subtitle": str(get(row, "nama_subtitle") or ""),
                "id_komponen": str(get(row, "id_komponen") or ""),
                "nama_komponen": str(get(row, "nama_komponen") or ""),
                "nama_detil": str(get(row, "nama_detil") or ""),
                "satuan": str(get(row, "satuan") or ""),
                "volume": vol,
                "koefisien": str(get(row, "koefisien") or ""),
                "harga_satuan": harga,
                "hasil": hasil_rp,
                "pajak": _to_float(get(row, "pajak")) or 0.0,
                "anggaran_rasionalisasi": rasio_rp,
                "sumber_dana": str(get(row, "sumber_dana") or ""),
                "rekening": str(get(row, "rekening") or ""),
                "nama_rekening": str(get(row, "nama_rekening") or ""),
                "tahap": str(get(row, "tahap") or ""),
                "user_id": str(get(row, "user_id") or ""),
                "is_pendidikan": _to_bool(get(row, "is_pendidikan")),
                "is_kesehatan": _to_bool(get(row, "is_kesehatan")),
                "is_infrastruktur": _to_bool(get(row, "is_infrastruktur")),
                "is_stunting": _to_bool(get(row, "is_stunting")),
                "is_miskin": _to_bool(get(row, "is_miskin")),
                "is_inflasi": _to_bool(get(row, "is_inflasi")),
                "_source_file": filename,
                "_sha256": sha256[:12],
                "_ingested_at": ingested_at,
            }
        )

    if not rows_raw:
        raise ValueError("File eBudgeting tidak memiliki baris data yang valid.")
    bronze_res = _write_iceberg_table(
        catalog, "bronze.ebudgeting_rincian_raw", pa.Table.from_pylist(rows_raw), mode="replace", key="nama_skpd"
    )
    return {
        "detected": "ebudgeting_rincian",
        "target_table": "bronze.ebudgeting_rincian_raw",
        "rows_extracted": len(rows_raw),
        "status": "Committed",
        "layers_written": [bronze_res],
    }


def _generic_records(rows: Any, filename: str, ingested_at: str) -> list[dict[str, Any]]:
    """Header row + data rows -> string records. Repeated or missing headers get unique names."""
    table = [list(row) for row in rows]
    if not table:
        return []
    width = max(len(row) for row in table)
    headers: list[str] = []
    for i, raw in enumerate(table[0] + [None] * (width - len(table[0]))):
        base = re.sub(r"[^a-zA-Z0-9_]+", "_", str(raw or "")).strip("_").lower() or f"col_{i}"
        name, n = base, 2
        while name in headers:
            name, n = f"{base}_{n}", n + 1
        headers.append(name)
    records = []
    for row in table[1:]:
        if all(v is None or v == "" for v in row):
            continue
        row += [None] * (width - len(row))
        rec = {h: ("" if v is None else str(v)) for h, v in zip(headers, row)}
        rec["_source_file"] = filename
        rec["_ingested_at"] = ingested_at
        records.append(rec)
    return records


def _write_generic_bronze(
    catalog: SqlCatalog, filename: str, records: list[dict[str, Any]], detected: str, ingested_at: str
) -> dict[str, Any]:
    tbl_id = f"bronze.{_sanitize_ident(filename)}_raw"
    empty = [{"_source_file": filename, "_ingested_at": ingested_at}]
    w = _write_iceberg_table(catalog, tbl_id, pa.Table.from_pylist(records or empty))
    return {
        "detected": detected,
        "target_table": tbl_id,
        "rows_extracted": len(records),
        "status": "Committed",
        "layers_written": [w],
    }


@_locked
def ingest_uploaded_file(filename: str, content: bytes) -> dict[str, Any]:
    ext = Path(filename).suffix.lower()
    if ext not in (".xlsx", ".xlsm", ".csv", ".pdf", *IMAGE_EXTS):
        raise ValueError(f"Format berkas '{ext or filename}' belum didukung.")
    ensure_warehouse()
    catalog = get_catalog()
    sha256 = _sha256_bytes(content)
    ingested_at = _now_iso()

    # Persist raw immutable file
    raw_path = RAW_DIR / f"{sha256[:10]}_{Path(filename).name}"
    raw_path.write_bytes(content)

    if ext in (".xlsx", ".xlsm"):
        wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        ws = wb[wb.sheetnames[0]]
        preview_rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i < 6:
                preview_rows.append(row)
            else:
                break
        row0_str = " ".join(str(x) for x in (preview_rows[0] if preview_rows else []) if x is not None)
        row3_str = " ".join(str(x) for x in (preview_rows[3] if len(preview_rows) > 3 else []) if x is not None)

        if "Perangkat Daerah" in row3_str and "Id Sub Kegiatan" in row3_str:
            res = _ingest_monitoring_excel(catalog, ws, filename, sha256, ingested_at)
        elif "id_skpd" in row0_str and "kegiatan_id" in row0_str:
            res = _ingest_ebudgeting_excel(catalog, ws, filename, sha256, ingested_at)
        else:
            records = _generic_records(ws.iter_rows(values_only=True), filename, ingested_at)
            res = _write_generic_bronze(catalog, filename, records, "generic_xlsx", ingested_at)
        wb.close()
        source_type = "xlsx"

    elif ext == ".csv":
        text = content.decode("utf-8-sig", errors="replace")
        header_line = text.split("\n", 1)[0]
        delimiter = max(",;\t|", key=lambda d: len(next(csv.reader([header_line], delimiter=d), [])))
        records = _generic_records(
            csv.reader(io.StringIO(text, newline=""), delimiter=delimiter), filename, ingested_at
        )
        res = _write_generic_bronze(catalog, filename, records, "generic_csv", ingested_at)
        source_type = "csv"

    elif ext == ".pdf":
        pages_data = []
        total_chars = 0
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for p_idx, page in enumerate(pdf.pages, start=1):
                txt = (page.extract_text() or "").strip()
                total_chars += len(txt)
                pages_data.append(
                    {
                        "source_file": filename,
                        "sha256": sha256[:12],
                        "page_number": p_idx,
                        "char_count": len(txt),
                        "text_excerpt": txt,
                        "needs_ocr": len(txt) < 20,
                        "ingested_at": ingested_at,
                    }
                )
        if not pages_data:
            pages_data.append(
                {
                    "source_file": filename,
                    "sha256": sha256[:12],
                    "page_number": 0,
                    "char_count": 0,
                    "text_excerpt": "",
                    "needs_ocr": True,
                    "ingested_at": ingested_at,
                }
            )
        w = _write_iceberg_table(
            catalog, "bronze.pdf_documents_raw", pa.Table.from_pylist(pages_data), mode="replace", key="sha256"
        )
        res = {
            "detected": "pdf_document",
            "target_table": "bronze.pdf_documents_raw",
            "rows_extracted": len(pages_data),
            "status": "Perlu Review" if total_chars < 50 else "Committed",
            "layers_written": [w],
        }
        source_type = "pdf"

    else:
        # Image -> extract text via local RapidOCR + store in bronze.media_assets_raw
        ocr_text = ""
        ocr_status = "PENDING_REVIEW"
        try:
            from vector_store import extract_image_ocr

            ocr_text = extract_image_ocr(raw_path)
            ocr_status = "EXTRACTED" if ocr_text else "NO_TEXT"
        except Exception:
            ocr_status = "PENDING_REVIEW"

        rec = [
            {
                "source_file": filename,
                "file_ext": ext,
                "size_bytes": len(content),
                "sha256": sha256[:12],
                "raw_path": str(raw_path.relative_to(ROOT_DIR)),
                "ocr_text": ocr_text,
                "ocr_status": ocr_status,
                "ingested_at": ingested_at,
            }
        ]
        w = _write_iceberg_table(
            catalog, "bronze.media_assets_raw", pa.Table.from_pylist(rec), mode="replace", key="sha256"
        )
        res = {
            "detected": "media_image",
            "target_table": "bronze.media_assets_raw",
            "rows_extracted": 1,
            "status": "Committed" if ocr_status == "EXTRACTED" else "Perlu Review",
            "layers_written": [w],
        }
        source_type = "image"

    log_entry = {
        "id": f"ing-{int(time.time() * 1000)}",
        "sourceName": filename,
        "sourceType": source_type,
        "targetTable": res["target_table"],
        "sha256": sha256[:8],
        "rowsExtracted": res["rows_extracted"],
        "ingestedAt": ingested_at,
        "status": res["status"],
    }
    append_ingest_log(log_entry)
    return {**res, "log": log_entry}


def ingest_web_url(url: str) -> dict[str, Any]:
    _validate_public_url(url)
    ensure_warehouse()
    catalog = get_catalog()
    ingested_at = _now_iso()

    with httpx.Client(
        timeout=20.0,
        follow_redirects=True,
        headers={"User-Agent": "SuraLake-Harvester/0.1"},
        # Runs before every request, including each redirect hop.
        event_hooks={"request": [lambda request: _validate_public_url(str(request.url))]},
    ) as client:
        resp = client.get(url)
        resp.raise_for_status()
        html = resp.text

    sha256 = _sha256_bytes(html.encode("utf-8", errors="replace"))
    soup = BeautifulSoup(html, "html.parser")
    title = (soup.title.string or "").strip() if soup.title else url

    links = []
    base_url = str(resp.url)
    for a in soup.find_all("a", href=True):
        raw_href = str(a["href"]).strip()
        if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        label = a.get_text(" ", strip=True)
        if any(ext in raw_href.lower() for ext in (".pdf", ".xlsx", ".xls", ".csv", "download", "rka")):
            resolved_href = urljoin(base_url, raw_href)
            links.append(
                {
                    "source_url": url,
                    "page_title": title,
                    "link_text": label[:240],
                    "link_href": resolved_href[:500],
                    "sha256": sha256[:12],
                    "ingested_at": ingested_at,
                }
            )

    if not links:
        body_text = soup.get_text(" ", strip=True)[:2000]
        links.append(
            {
                "source_url": url,
                "page_title": title,
                "link_text": body_text[:240],
                "link_href": url,
                "sha256": sha256[:12],
                "ingested_at": ingested_at,
            }
        )

    w = _write_iceberg_table(
        catalog, "bronze.web_harvest_raw", pa.Table.from_pylist(links), mode="replace", key="source_url"
    )
    log_entry = {
        "id": f"web-{int(time.time() * 1000)}",
        "sourceName": url.replace("https://", "").replace("http://", "")[:60],
        "sourceType": "web",
        "targetTable": "bronze.web_harvest_raw",
        "sha256": sha256[:8],
        "rowsExtracted": len(links),
        "ingestedAt": ingested_at,
        "status": "Committed",
    }
    append_ingest_log(log_entry)
    return {
        "detected": "web_url",
        "target_table": "bronze.web_harvest_raw",
        "rows_extracted": len(links),
        "status": "Committed",
        "layers_written": [w],
        "log": log_entry,
    }


# ---------- QUERY & INSPECTION ----------

def get_catalog_summary() -> dict[str, Any]:
    catalog = get_catalog()
    tables_out: list[dict[str, Any]] = []
    snapshots_out: list[dict[str, Any]] = []

    for ns in NAMESPACES:
        for _, tbl_name in catalog.list_tables(ns):
            full_name = f"{ns}.{tbl_name}"
            tbl = catalog.load_table(full_name)
            snap = tbl.current_snapshot()

            # Read row count and size from Iceberg metadata (avoids scanning full Parquet files)
            files_df = tbl.inspect.files().to_pylist()
            size_bytes = sum(int(f.get("file_size_in_bytes", 0)) for f in files_df)
            row_count = sum(int(f.get("record_count", 0)) for f in files_df)
            sample_arrow = tbl.scan(limit=1).to_arrow() if row_count > 0 else None

            cols = [
                {
                    "name": field.name,
                    "type": str(field.field_type),
                    "sample": (
                        str(sample_arrow.column(field.name)[0].as_py())[:60]
                        if sample_arrow is not None and sample_arrow.num_rows > 0
                        else "—"
                    ),
                }
                for field in tbl.schema().fields
            ]

            ts_str = _fmt_ms(snap.timestamp_ms) if snap else "—"

            tables_out.append(
                {
                    "name": full_name,
                    "layer": ns,
                    "format": "Iceberg v2 · Parquet",
                    "rows": row_count,
                    "files": len(files_df),
                    "sizeMb": round(size_bytes / (1024 * 1024), 3),
                    "snapshotId": str(snap.snapshot_id) if snap else "—",
                    "updatedAt": ts_str,
                    "columns": cols,
                }
            )

            for s in tbl.snapshots():
                snapshots_out.append(
                    {
                        "id": str(s.snapshot_id),
                        "table": full_name,
                        "layer": ns,
                        "committedAt": _fmt_ms(s.timestamp_ms),
                        "timestampMs": s.timestamp_ms,
                        "operation": s.summary.operation.value if s.summary else "append",
                    }
                )

    snapshots_out.sort(key=lambda x: x["timestampMs"], reverse=True)
    return {"tables": tables_out, "snapshots": snapshots_out}


def has_curated_data(tables: list[dict[str, Any]]) -> bool:
    """True once any Silver or Gold table holds rows; raw Bronze data alone is not ready for analysis."""
    return any(t["layer"] != "bronze" and t["rows"] > 0 for t in tables)


def get_overview_data() -> dict[str, Any]:
    catalog = get_catalog()
    cat = get_catalog_summary()
    tables = cat["tables"]

    layer_counts = {
        ns: {
            "tables": sum(1 for t in tables if t["layer"] == ns),
            "rows": sum(t["rows"] for t in tables if t["layer"] == ns),
            "sizeMb": round(sum(t["sizeMb"] for t in tables if t["layer"] == ns), 3),
        }
        for ns in NAMESPACES
    }

    opd_rows: list[dict[str, Any]] = []
    if catalog.table_exists("gold.apbd_opd_summary"):
        opd_arrow = _read_table_arrow(catalog, "gold.apbd_opd_summary")
        if opd_arrow is not None:
            opd_rows = opd_arrow.to_pylist()

    tematik_rows: list[dict[str, Any]] = []
    if catalog.table_exists("gold.apbd_tematik_prioritas"):
        t_arrow = _read_table_arrow(catalog, "gold.apbd_tematik_prioritas")
        if t_arrow is not None:
            tematik_rows = t_arrow.to_pylist()

    def total(column: str) -> int:
        return sum(int(r.get(column) or 0) for r in opd_rows)

    has_sp2d = any(r.get("sp2d_rp") is not None for r in opd_rows)
    total_alokasi = total("alokasi_rp")
    total_sp2d = total("sp2d_rp") if has_sp2d else None
    total_realisasi = total("total_realisasi_rp") if has_sp2d else None
    total_anomali = total("jumlah_anomali")
    serapan_pct = None
    if has_sp2d:
        serapan_pct = round((total_sp2d / total_alokasi) * 100, 1) if total_alokasi > 0 else 0.0

    return {
        "isEmpty": len(tables) == 0,
        "readyForAnalysis": has_curated_data(tables),
        "totals": {
            "alokasiRp": total_alokasi,
            "realisasiRp": total_realisasi,
            "sp2dRp": total_sp2d,
            "serapanPct": serapan_pct,
            "opdCount": len(opd_rows),
            "anomaliCount": total_anomali,
            "tableCount": len(tables),
        },
        "layers": layer_counts,
        "opd": opd_rows,
        "tematik": tematik_rows,
        "latestSnapshotId": cat["snapshots"][0]["id"] if cat["snapshots"] else None,
    }


@contextmanager
def _sql_sandbox(catalog: SqlCatalog, allowed_namespaces: tuple[str, ...] = NAMESPACES):
    """In-memory DuckDB holding the allowed Iceberg namespaces, with no file/network access and a time limit.

    Namespaces left out are never loaded, so no query can reach them.
    """
    con = duckdb.connect()
    timer = threading.Timer(SQL_TIMEOUT_S, con.interrupt)
    try:
        for ns in allowed_namespaces:
            con.execute(f"CREATE SCHEMA IF NOT EXISTS {ns}")
            for _, tbl_name in catalog.list_tables(ns):
                arrow = _read_table_arrow(catalog, f"{ns}.{tbl_name}")
                if arrow is not None:
                    # A view over a registered Arrow table would expose its internal name in SHOW TABLES, so copy.
                    # shortcut: copies every table per query (within memory_limit); cache if data reaches 100s of MB.
                    con.register("_load", arrow)
                    con.execute(f'CREATE TABLE {ns}."{tbl_name}" AS SELECT * FROM _load')
                    con.unregister("_load")
        con.execute("SET memory_limit = '1GB'")
        con.execute("SET enable_external_access = false")
        timer.start()
        yield con
    except duckdb.InterruptException as exc:
        raise ValueError(f"Query dihentikan karena lebih dari {SQL_TIMEOUT_S} detik.") from exc
    finally:
        timer.cancel()
        con.close()


def run_duckdb_sql(query: str, allowed_namespaces: tuple[str, ...] = NAMESPACES) -> dict[str, Any]:
    q = _validate_readonly_sql(query)
    catalog = get_catalog()
    t0 = time.perf_counter()
    with _sql_sandbox(catalog, allowed_namespaces) as con:
        rel = con.execute(q)
        cols = [d[0] for d in rel.description] if rel.description else []
        raw_rows = rel.fetchmany(SQL_MAX_ROWS + 1)
    rows = [[("" if v is None else str(v)) for v in r] for r in raw_rows[:SQL_MAX_ROWS]]
    return {
        "columns": cols,
        "rows": rows,
        "rowCount": len(rows),
        "truncated": len(raw_rows) > SQL_MAX_ROWS,
        "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
    }


def reset_warehouse() -> dict[str, Any]:
    from vector_store import _VECTOR_LOCK

    with _WAREHOUSE_LOCK, _VECTOR_LOCK:
        if WAREHOUSE_DIR.exists():
            shutil.rmtree(WAREHOUSE_DIR)
        get_catalog()
        return {"status": "reset", "message": "Warehouse Apache Iceberg dikosongkan kembali."}


# ---------- CRUD & MEDALLION PROMOTION ----------

def _validate_table_ident(namespace: str, table: str) -> str:
    if namespace not in NAMESPACES:
        raise ValueError(f"Namespace tidak valid: {namespace}")
    if not re.match(r"^[a-zA-Z0-9_]+$", table):
        raise ValueError(f"Nama tabel tidak valid: {table}")
    return f"{namespace}.{table}"


def _cast_value_for_field(val: Any, field_type: pa.DataType) -> Any:
    if pa.types.is_boolean(field_type):
        return _to_bool(val)
    if pa.types.is_integer(field_type):
        return _to_int(val)
    if pa.types.is_floating(field_type):
        return _to_float(val)
    return "" if val is None else str(val)


def _cast_row_to_schema(row_data: dict[str, Any], schema: pa.Schema) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for field in schema:
        out[field.name] = _cast_value_for_field(row_data.get(field.name), field.type)
    return out


def _snapshot_id(tbl: Any) -> str | None:
    snap = tbl.current_snapshot()
    return str(snap.snapshot_id) if snap else None


def _load_existing_table(namespace: str, table: str) -> tuple[str, SqlCatalog, Any]:
    ident = _validate_table_ident(namespace, table)
    catalog = get_catalog()
    if not catalog.table_exists(ident):
        raise ValueError(f"Tabel {ident} tidak ditemukan.")
    return ident, catalog, catalog.load_table(ident)


def _rows_for_edit(tbl: Any, row_idx: int, snapshot_id: str) -> tuple[pa.Schema, list[dict[str, Any]]]:
    if _snapshot_id(tbl) != snapshot_id:
        raise StaleTableError("Tabel sudah berubah sejak ditampilkan. Muat ulang, lalu coba lagi.")
    arrow = tbl.scan().to_arrow()
    rows = arrow.to_pylist()
    if row_idx < 0 or row_idx >= len(rows):
        raise ValueError(f"Index baris {row_idx} di luar jangkauan (0..{len(rows) - 1}).")
    return arrow.schema, rows


def _after_row_change(catalog: SqlCatalog, ident: str) -> list[dict[str, Any]]:
    _drop_stale_vectors(ident)
    if ident in ("silver.monitoring_pekerjaan", "silver.ebudgeting_rincian"):
        return _rebuild_gold_layers(catalog)
    if ident.startswith("silver.") and catalog.table_exists(_default_gold_target(ident)):
        return promote_silver_to_gold(ident)["gold"]
    return []


def get_table_rows(
    namespace: str, table: str, limit: int = 25, offset: int = 0, search: str = ""
) -> dict[str, Any]:
    ident = _validate_table_ident(namespace, table)
    catalog = get_catalog()
    if not catalog.table_exists(ident):
        raise ValueError(f"Tabel {ident} tidak ditemukan.")
    tbl = catalog.load_table(ident)
    arrow = tbl.scan().to_arrow()
    all_rows = arrow.to_pylist()
    cols = [{"name": f.name, "type": str(f.type)} for f in arrow.schema]

    q = search.strip().lower()
    indexed: list[dict[str, Any]] = []
    for idx, row in enumerate(all_rows):
        if q and not any(q in str(v).lower() for v in row.values()):
            continue
        indexed.append({"_row_idx": idx, **row})

    page = indexed[offset : offset + limit]
    return {
        "table": ident,
        "layer": namespace,
        "snapshotId": _snapshot_id(tbl),
        "columns": cols,
        "totalRows": len(all_rows),
        "filteredRows": len(indexed),
        "offset": offset,
        "limit": limit,
        "rows": page,
    }


@_locked
def create_table_row(namespace: str, table: str, row_data: dict[str, Any]) -> dict[str, Any]:
    ident, catalog, tbl = _load_existing_table(namespace, table)
    arrow = tbl.scan().to_arrow()
    casted = _cast_row_to_schema(row_data, arrow.schema)
    tbl.append(pa.Table.from_pylist([casted], schema=arrow.schema))
    snapshot_id = _snapshot_id(tbl)
    return {
        "status": "created",
        "table": ident,
        "snapshot_id": snapshot_id,
        "totalRows": arrow.num_rows + 1,
        "goldRebuilt": _after_row_change(catalog, ident),
    }


@_locked
def update_table_row(
    namespace: str, table: str, row_idx: int, row_data: dict[str, Any], snapshot_id: str
) -> dict[str, Any]:
    ident, catalog, tbl = _load_existing_table(namespace, table)
    schema, rows = _rows_for_edit(tbl, row_idx, snapshot_id)
    rows[row_idx] = _cast_row_to_schema({**rows[row_idx], **row_data}, schema)
    tbl.overwrite(pa.Table.from_pylist(rows, schema=schema))
    new_snapshot = _snapshot_id(tbl)
    return {
        "status": "updated",
        "table": ident,
        "row_idx": row_idx,
        "snapshot_id": new_snapshot,
        "goldRebuilt": _after_row_change(catalog, ident),
    }


@_locked
def delete_table_row(namespace: str, table: str, row_idx: int, snapshot_id: str) -> dict[str, Any]:
    ident, catalog, tbl = _load_existing_table(namespace, table)
    schema, rows = _rows_for_edit(tbl, row_idx, snapshot_id)
    rows.pop(row_idx)
    tbl.overwrite(pa.Table.from_pylist(rows, schema=schema))
    new_snapshot = _snapshot_id(tbl)
    return {
        "status": "deleted",
        "table": ident,
        "row_idx": row_idx,
        "remainingRows": len(rows),
        "snapshot_id": new_snapshot,
        "goldRebuilt": _after_row_change(catalog, ident),
    }


def drop_iceberg_table(namespace: str, table: str) -> dict[str, Any]:
    ident = _validate_table_ident(namespace, table)
    with _WAREHOUSE_LOCK:
        catalog = get_catalog()
        if not catalog.table_exists(ident):
            raise ValueError(f"Tabel {ident} tidak ditemukan.")
        catalog.drop_table(ident)
        _drop_stale_vectors(ident)
        return {"status": "dropped", "table": ident, "goldRebuilt": []}


_NUMBER_TEXT_RE = re.compile(
    r"-?(0|[1-9]\d*)([.,]\d+)?|-?[1-9]\d{0,2}(\.\d{3})+(,\d+)?|-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?"
)
_CODE_COLUMN_RE = re.compile(r"(^|_)(id|kode|nomor|no|nip|nik|npwp|tahun|telp|hp|sha256)(_|$)")


def _convert_numeric_columns(rows: list[dict[str, Any]]) -> None:
    """Turn a text column into numbers when every filled value is a number. Codes stay text."""
    for col in list(rows[0]) if rows else []:
        if _CODE_COLUMN_RE.search(col):
            continue
        values = [r.get(col) for r in rows if r.get(col) not in (None, "")]
        if not values or not all(
            isinstance(v, str) and _NUMBER_TEXT_RE.fullmatch(v) and sum(c.isdigit() for c in v) <= 15
            for v in values
        ):
            continue
        whole = all(_to_float(v).is_integer() for v in values)
        for r in rows:
            number = _to_float(r.get(col))
            r[col] = None if number is None else int(number) if whole else number


@_locked
def promote_bronze_to_silver(
    source_table: str, target_table: str | None = None
) -> dict[str, Any]:
    """Read a Bronze Iceberg table, clean/standardize it, write to Silver, and rebuild Gold."""
    if not source_table.startswith("bronze."):
        raise ValueError("Source table harus berada di namespace bronze (contoh: bronze.nama_raw).")
    catalog = get_catalog()
    bronze_arrow = _read_table_arrow(catalog, source_table)
    if bronze_arrow is None:
        raise ValueError(f"Tabel {source_table} tidak ditemukan.")

    raw_rows = bronze_arrow.to_pylist()
    promoted_at = _now_iso()

    if source_table == "bronze.monitoring_pd_raw":
        silver_rows = []
        for r in raw_rows:
            pd_name = str(r.get("perangkat_daerah") or "").strip()
            if not pd_name:
                continue
            kode_std, internal_id = _parse_sub_kegiatan_id(r.get("id_sub_kegiatan_raw"))
            nama_sub_clean, nama_ppkm = _split_sub_kegiatan_ppkm(r.get("nama_sub_kegiatan_raw"))
            alokasi = _to_int(r.get("alokasi_rp")) or 0
            penggunaan_dana = _to_int(r.get("penggunaan_dana_rp")) or 0
            sp2d = _to_int(r.get("sp2d_rp")) or 0
            renc_fisik = _to_float(r.get("rencana_fisik_pct")) or 0.0
            real_fisik = _parse_fisik_real(r.get("realisasi_fisik_pct"))
            dq_flags = []
            # Excel col 12 (rencana_fisik_pct) is penggunaan_dana/alokasi*100, NOT physical progress;
            # only col 15 (realisasi_fisik_pct) measures actual physical completion.
            if real_fisik > 100.0:
                dq_flags.append("FISIK_OVER_100")
            # Many BLUD/multi-item packages keep a placeholder alokasi_rp (e.g. Rp 50 jt) while the
            # real operational spending plan lives in penggunaan_dana_rp. True overbudget means SP2D
            # exceeds BOTH alokasi_rp and penggunaan_dana_rp.
            effective_ceiling = max(alokasi, penggunaan_dana)
            if sp2d > 0 and sp2d > effective_ceiling:
                dq_flags.append("OVERBUDGET")
            elif penggunaan_dana > 0 and sp2d > penggunaan_dana:
                dq_flags.append("SP2D_OVER_PENGGUNAAN_DANA")
            silver_rows.append(
                {
                    "nama_opd": pd_name,
                    "kode_sub_kegiatan": kode_std,
                    "sub_kegiatan_internal_id": internal_id or 0,
                    "nama_sub_kegiatan": nama_sub_clean,
                    "nama_ppkm": nama_ppkm,
                    "id_pekerjaan": str(r.get("id_pakerjaan") or ""),
                    "nama_pekerjaan": str(r.get("nama_pakerjaan") or "").strip(),
                    "metode_pekerjaan": str(r.get("metode_pekerjaan") or "").strip(),
                    "alokasi_rp": alokasi,
                    "penggunaan_dana_rp": penggunaan_dana,
                    "rencana_fisik_pct": renc_fisik,
                    "realisasi_fisik_pct": real_fisik,
                    "total_realisasi_rp": _to_int(r.get("total_realisasi_rp")) or 0,
                    "sp2d_rp": sp2d,
                    "rekanan": str(r.get("rekanan") or "").strip(),
                    "nilai_kontrak_rp": _to_int(r.get("nilai_kontrak_rp")) or 0,
                    "dq_flag": ",".join(dq_flags),
                    "periode_laporan": str(r.get("_periode_raw") or ""),
                }
            )
        if not silver_rows:
            raise ValueError(f"Tabel {source_table} tidak memiliki baris valid untuk dipromosikan.")
        target_id = target_table or "silver.monitoring_pekerjaan"
        silver_res = _write_iceberg_table(catalog, target_id, pa.Table.from_pylist(silver_rows), mode="overwrite")

    elif source_table == "bronze.ebudgeting_rincian_raw":
        silver_rows = []
        for r in raw_rows:
            silver_rows.append(
                {
                    "nama_opd": str(r.get("nama_skpd") or "").strip(),
                    "kode_detail_kegiatan": str(r.get("kode_detail_kegiatan") or "").strip(),
                    "kode_sub_kegiatan": str(r.get("kegiatan_id") or "").strip(),
                    "nama_sub_kegiatan": str(r.get("nama_sub_kegiatan") or "").strip(),
                    "nama_subtitle": str(r.get("nama_subtitle") or "").strip(),
                    "nama_komponen": str(r.get("nama_komponen") or "").strip(),
                    "nama_detil": str(r.get("nama_detil") or "").strip(),
                    "satuan": str(r.get("satuan") or "").strip(),
                    "volume": _to_float(r.get("volume")) or 0.0,
                    "koefisien": str(r.get("koefisien") or "").strip(),
                    "harga_satuan_rp": _to_int(r.get("harga_satuan")) or 0,
                    "pajak_pct": _to_float(r.get("pajak")) or 0.0,
                    "hasil_rp": _to_int(r.get("hasil")) or 0,
                    "anggaran_rasionalisasi_rp": _to_int(r.get("anggaran_rasionalisasi")) or 0,
                    "sumber_dana": str(r.get("sumber_dana") or "").strip(),
                    "rekening": str(r.get("rekening") or "").strip(),
                    "nama_rekening": str(r.get("nama_rekening") or "").strip(),
                    "tahap": str(r.get("tahap") or "").strip(),
                    "is_pendidikan": _to_bool(r.get("is_pendidikan")),
                    "is_kesehatan": _to_bool(r.get("is_kesehatan")),
                    "is_infrastruktur": _to_bool(r.get("is_infrastruktur")),
                    "is_stunting": _to_bool(r.get("is_stunting")),
                    "is_miskin": _to_bool(r.get("is_miskin")),
                    "is_inflasi": _to_bool(r.get("is_inflasi")),
                }
            )
        if not silver_rows:
            raise ValueError(f"Tabel {source_table} tidak memiliki baris valid untuk dipromosikan.")
        target_id = target_table or "silver.ebudgeting_rincian"
        silver_res = _write_iceberg_table(catalog, target_id, pa.Table.from_pylist(silver_rows), mode="overwrite")

    else:
        # Generic Bronze -> Silver cleaner: trim strings, drop empty rows, deduplicate, add dq_flag
        seen: set[str] = set()
        silver_rows = []
        for r in raw_rows:
            cleaned = {}
            non_meta_values = []
            for k, v in r.items():
                if k.startswith("_"):
                    continue
                val = v.strip() if isinstance(v, str) else v
                cleaned[k] = val
                if val not in (None, ""):
                    non_meta_values.append(str(val))
            if not non_meta_values:
                continue
            sig = json.dumps(cleaned, sort_keys=True, ensure_ascii=False, default=str)
            if sig in seen:
                continue
            seen.add(sig)
            cleaned["dq_flag"] = ""
            cleaned["_promoted_at"] = promoted_at
            silver_rows.append(cleaned)

        _convert_numeric_columns(silver_rows)
        base = source_table.split(".", 1)[1]
        base_clean = re.sub(r"_raw$", "", base) + "_clean"
        target_id = target_table or f"silver.{base_clean}"
        if not target_id.startswith("silver."):
            target_id = f"silver.{target_id}"
        silver_res = _write_iceberg_table(
            catalog,
            target_id,
            pa.Table.from_pylist(silver_rows or [{"dq_flag": "EMPTY", "_promoted_at": promoted_at}]),
            mode="overwrite",
        )

    return {
        "status": "promoted",
        "source": source_table,
        "silver": silver_res,
        "gold": [],
    }


@_locked
def rebuild_gold() -> dict[str, Any]:
    catalog = get_catalog()
    res = _rebuild_gold_layers(catalog)
    return {"status": "rebuilt", "layers_written": res}


def _default_gold_target(silver_table: str) -> str:
    return "gold." + re.sub(r"_clean$", "", silver_table.split(".", 1)[1]) + "_summary"


@_locked
def promote_silver_to_gold(
    source_table: str, target_table: str | None = None
) -> dict[str, Any]:
    """Promote a Silver Iceberg table to Gold (curated summary)."""
    if not source_table.startswith("silver."):
        raise ValueError("Source table harus berada di namespace silver (contoh: silver.nama_clean).")
    catalog = get_catalog()
    silver_arrow = _read_table_arrow(catalog, source_table)
    if silver_arrow is None:
        raise ValueError(f"Tabel {source_table} tidak ditemukan.")

    if source_table in ("silver.monitoring_pekerjaan", "silver.ebudgeting_rincian") and not target_table:
        gold_res = _rebuild_gold_layers(catalog)
        return {
            "status": "promoted",
            "source": source_table,
            "gold": gold_res,
        }

    # Generic Silver -> Gold:
    # - Document/Web/Media tables (containing link_href, text_excerpt, or ocr_text) keep curated rows intact for Gold & Vector AI
    # - Tabular numeric tables group by first string dimension column
    col_names = {f.name for f in silver_arrow.schema}
    con = duckdb.connect()
    try:
        con.register("src_silver", silver_arrow)
        if col_names & {"link_href", "text_excerpt", "ocr_text"}:
            keep_cols = [
                f'"{f.name}"'
                for f in silver_arrow.schema
                if not f.name.startswith("_") and f.name != "dq_flag"
            ]
            gold_arrow = con.sql(f"SELECT {', '.join(keep_cols)} FROM src_silver").to_arrow_table()
        else:
            str_cols = [
                f.name
                for f in silver_arrow.schema
                if (pa.types.is_string(f.type) or pa.types.is_large_string(f.type)) and not f.name.startswith("_") and f.name != "dq_flag"
            ]
            num_cols = [
                f.name
                for f in silver_arrow.schema
                if (pa.types.is_integer(f.type) or pa.types.is_floating(f.type))
                and not f.name.startswith("_")
            ]

            if str_cols and num_cols:
                dim = str_cols[0]
                aggs = ", ".join(
                    f'COALESCE(SUM("{c}"), 0)::'
                    f'{"BIGINT" if pa.types.is_integer(silver_arrow.schema.field(c).type) else "DOUBLE"} AS "total_{c}"'
                    for c in num_cols
                )
                gold_arrow = con.sql(
                    f'SELECT "{dim}", COUNT(*)::BIGINT AS jumlah_baris, {aggs} '
                    f'FROM src_silver GROUP BY "{dim}" ORDER BY jumlah_baris DESC'
                ).to_arrow_table()
            elif str_cols:
                dim = str_cols[0]
                gold_arrow = con.sql(
                    f'SELECT "{dim}", COUNT(*)::BIGINT AS jumlah_baris '
                    f'FROM src_silver GROUP BY "{dim}" ORDER BY jumlah_baris DESC'
                ).to_arrow_table()
            else:
                gold_arrow = silver_arrow
    finally:
        con.close()

    target_id = target_table or _default_gold_target(source_table)
    if not target_id.startswith("gold."):
        target_id = f"gold.{target_id}"
    gold_written = _write_iceberg_table(catalog, target_id, gold_arrow, mode="overwrite")
    return {
        "status": "promoted",
        "source": source_table,
        "gold": [gold_written],
    }


@_locked
def save_sql_as_gold(query: str, table_name: str) -> dict[str, Any]:
    """Execute a read-only DuckDB SQL query and save its output as a Gold Iceberg table."""
    q = _validate_readonly_sql(query)
    if not re.match(r"(?i)(select|with|from)\b", q):
        raise ValueError("Hanya query SELECT / WITH yang bisa disimpan ke Gold.")

    raw_name = table_name.strip().lower()
    if raw_name.startswith("gold."):
        raw_name = raw_name[5:]
    clean_name = re.sub(r"[^a-z0-9_]+", "_", raw_name).strip("_")
    if not clean_name:
        raise ValueError("Nama tabel Gold tidak valid.")
    target_id = f"gold.{clean_name}"

    catalog = get_catalog()
    with _sql_sandbox(catalog) as con:
        out_arrow = con.sql(q).to_arrow_table()

    written = _write_iceberg_table(catalog, target_id, out_arrow, mode="overwrite")
    return {"status": "saved", **written}
