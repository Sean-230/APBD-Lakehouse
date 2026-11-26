from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

from lakehouse import (
    get_catalog_summary,
    get_overview_data,
    run_duckdb_sql,
)
from vector_store import get_vector_stats, search_vectors

ENV_PATH = Path(__file__).resolve().parent / ".env"
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODELS = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
]


def _load_env_file() -> None:
    if not ENV_PATH.exists():
        return
    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _get_groq_config() -> tuple[str, list[str]]:
    _load_env_file()
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    preferred = os.environ.get("GROQ_MODEL", "").strip()
    models = ([preferred] if preferred else []) + [m for m in DEFAULT_MODELS if m != preferred]
    return api_key, models


def get_chat_status() -> dict[str, Any]:
    api_key, models = _get_groq_config()
    return {
        "configured": bool(api_key),
        "provider": "Groq",
        "model": models[0] if models else DEFAULT_MODELS[0],
    }


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "run_sql_query",
            "description": (
                "Menjalankan query DuckDB SQL (hanya SELECT/WITH) terhadap tabel Apache Iceberg "
                "(bronze.*, silver.*, gold.*) untuk mendapatkan angka pasti, total, ranking, filter, atau rincian APBD Surabaya."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query SQL DuckDB yang valid (SELECT / WITH). Gunakan LIMIT <= 30 untuk daftar baris.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Alasan singkat kenapa query ini dijalankan.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_lakehouse_overview",
            "description": (
                "Mengambil ringkasan cepat APBD Surabaya saat ini: total alokasi, total SP2D, persentase serapan, "
                "jumlah OPD, jumlah anomali, anggaran tematik prioritas, dan status layer Bronze/Silver/Gold."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_vector_knowledge",
            "description": (
                "Pencarian semantik (Vector Search) terhadap seluruh dokumen yang telah di-index: PDF, gambar hasil OCR, "
                "halaman web hasil scrape surabaya.go.id, CSV teks, dan ringkasan Gold. Gunakan tool ini untuk mencari topik, "
                "isi dokumen PDF/gambar, tautan web, atau informasi tidak terstruktur."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Pertanyaan atau kata kunci pencarian semantik.",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Jumlah potongan teks relevan yang diambil (default 6).",
                    },
                },
                "required": ["query"],
            },
        },
    },
]


def _build_system_prompt() -> str:
    cat = get_catalog_summary()
    tables = cat.get("tables", [])
    if not tables:
        schema_block = "(Warehouse Apache Iceberg saat ini masih kosong — belum ada tabel yang di-ingest.)"
    else:
        lines = []
        for t in tables:
            cols = ", ".join(f"{c['name']}:{c['type']}" for c in t["columns"][:18])
            lines.append(f"- {t['name']} ({t['rows']} baris): {cols}")
        schema_block = "\n".join(lines)

    vstats = get_vector_stats()
    vector_note = (
        f"Vector Index lokal aktif: {vstats['totalChunks']} chunks dari {len(vstats['sources'])} sumber."
        if vstats["totalChunks"] > 0
        else "Vector Index lokal masih kosong (0 chunks)."
    )

    return f"""Kamu adalah **SuraLake AI**, asisten analis data APBD Kota Surabaya yang terhubung langsung ke Apache Iceberg Data Lakehouse (Bronze → Silver → Gold) melalui DuckDB dan Vector Search lokal.

Aturan wajib:
1. Jawab dalam Bahasa Indonesia yang jelas, ramah, dan mudah dipahami oleh orang non-teknis (atau ikuti bahasa pengguna jika bertanya dalam bahasa Inggris).
2. **JANGAN PERNAH mengarang atau menebak angka.** Untuk hitungan angka, total, ranking, atau filter tabel, WAJIB panggil `run_sql_query` atau `get_lakehouse_overview`.
3. Untuk pertanyaan tentang isi dokumen PDF, gambar (OCR), hasil scrape web, tautan RKA, atau pencarian topik bebas, panggil `search_vector_knowledge`.
4. Prioritaskan query pada tabel `gold.*` untuk ringkasan OPD/tematik/anomali, dan `silver.*` untuk rincian pekerjaan atau komponen eBudgeting. Jika query `silver.ebudgeting_rincian`, selalu perhatikan kolom `tahap` (filter `LOWER(tahap) = 'pak'` atau kelompokkan per `tahap` agar tidak double-counting!).
5. Format angka Rupiah agar mudah dibaca (contoh: **Rp 9,59 Triliun**, **Rp 500,5 Miliar**, atau angka lengkap jika diminta) dan sebutkan persentase dengan rapi.
6. Jika warehouse masih kosong, beri tahu pengguna dengan ramah bahwa belum ada data yang diunggah.
7. Untuk RSUD dengan serapan SP2D sangat rendah, beri catatan singkat bahwa RSUD berstatus BLUD sehingga sebagian pencairan tidak melewati mekanisme SP2D reguler.

Status Vector Index: {vector_note}

Tabel Apache Iceberg yang tersedia saat ini:
{schema_block}
"""


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "get_lakehouse_overview":
        ov = get_overview_data()
        return {
            "isEmpty": ov["isEmpty"],
            "totals": ov["totals"],
            "layers": ov["layers"],
            "tematik": ov["tematik"],
            "top_5_opd": ov["opd"][:5],
            "latestSnapshotId": ov["latestSnapshotId"],
        }
    if name == "run_sql_query":
        query = str(args.get("query") or "").strip()
        res = run_duckdb_sql(query)
        # Keep payload compact for LLM context
        return {
            "columns": res["columns"],
            "rows": res["rows"][:40],
            "rowCount": res["rowCount"],
            "elapsedMs": res["elapsedMs"],
        }
    if name == "search_vector_knowledge":
        q = str(args.get("query") or "").strip()
        top_k = int(args.get("top_k") or 6)
        return search_vectors(q, top_k=min(max(1, top_k), 12))
    return {"error": f"Tool tidak dikenal: {name}"}


def _call_groq(
    api_key: str,
    models: list[str],
    messages: list[dict[str, Any]],
    use_tools: bool = True,
) -> tuple[dict[str, Any], str]:
    last_err: Exception | None = None
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=45.0) as client:
        for model in models:
            payload: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": 0.2,
                "max_tokens": 1400,
            }
            if use_tools:
                payload["tools"] = TOOLS
                payload["tool_choice"] = "auto"
            try:
                resp = client.post(GROQ_API_URL, headers=headers, json=payload)
                if resp.status_code in (429, 500, 502, 503, 504):
                    last_err = RuntimeError(f"Groq {model} HTTP {resp.status_code}: {resp.text[:200]}")
                    continue
                if resp.status_code == 400 and use_tools and "tool" in resp.text.lower():
                    # Retry same model once without tools if model rejects tool call schema
                    payload.pop("tools", None)
                    payload.pop("tool_choice", None)
                    resp = client.post(GROQ_API_URL, headers=headers, json=payload)
                if resp.status_code >= 400:
                    last_err = RuntimeError(f"Groq {model} HTTP {resp.status_code}: {resp.text[:300]}")
                    continue
                return resp.json(), model
            except Exception as exc:
                last_err = exc
                continue
    raise RuntimeError(f"Gagal menghubungi Groq API: {last_err}")


def chat_with_lakehouse(
    message: str, history: list[dict[str, str]] | None = None
) -> dict[str, Any]:
    api_key, models = _get_groq_config()
    if not api_key:
        raise RuntimeError("GROQ_API_KEY belum dikonfigurasi di backend/.env.")

    user_msg = message.strip()
    if not user_msg:
        raise ValueError("Pesan tidak boleh kosong.")

    messages: list[dict[str, Any]] = [{"role": "system", "content": _build_system_prompt()}]
    for item in (history or [])[-8:]:
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:2500]})
    messages.append({"role": "user", "content": user_msg})

    sql_used: list[dict[str, Any]] = []
    used_model = models[0]

    for _round in range(4):
        data, used_model = _call_groq(api_key, models, messages, use_tools=(_round < 3))
        choice = data["choices"][0]
        assistant_msg = choice["message"]
        tool_calls = assistant_msg.get("tool_calls") or []

        if not tool_calls:
            answer = (assistant_msg.get("content") or "").strip()
            ov = get_overview_data()
            return {
                "answer": answer or "Maaf, saya belum bisa menyusun jawaban untuk pertanyaan tersebut.",
                "model": used_model,
                "sqlUsed": sql_used,
                "snapshotId": ov.get("latestSnapshotId"),
            }

        # Append assistant tool call request
        messages.append(
            {
                "role": "assistant",
                "content": assistant_msg.get("content") or "",
                "tool_calls": tool_calls,
            }
        )

        for tc in tool_calls:
            fn = tc.get("function", {})
            fn_name = fn.get("name", "")
            raw_args = fn.get("arguments") or "{}"
            try:
                parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                parsed_args = {}

            try:
                tool_out = _execute_tool(fn_name, parsed_args)
                if fn_name == "run_sql_query":
                    sql_used.append(
                        {
                            "query": parsed_args.get("query", ""),
                            "reason": parsed_args.get("reason", ""),
                            "rowCount": tool_out.get("rowCount", 0),
                            "elapsedMs": tool_out.get("elapsedMs", 0),
                        }
                    )
            except Exception as exc:
                tool_out = {"error": str(exc)}
                if fn_name == "run_sql_query":
                    sql_used.append(
                        {
                            "query": parsed_args.get("query", ""),
                            "reason": parsed_args.get("reason", ""),
                            "error": str(exc),
                        }
                    )

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", "call_0"),
                    "content": json.dumps(tool_out, ensure_ascii=False),
                }
            )

    ov = get_overview_data()
    return {
        "answer": "Maaf, pemrosesan query membutuhkan terlalu banyak langkah. Coba persempit pertanyaan kamu.",
        "model": used_model,
        "sqlUsed": sql_used,
        "snapshotId": ov.get("latestSnapshotId"),
    }
