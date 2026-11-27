from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from lakehouse import (
    get_catalog,
    get_catalog_summary,
    get_overview_data,
    has_curated_data,
    run_duckdb_sql,
)
from vector_store import get_vector_stats, search_vectors

ENV_PATH = Path(__file__).resolve().parent / ".env"
# Gemini's OpenAI-compatible endpoint: same request/response shape, including tool calls.
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
# Tried in order; a busy (503) or rate-limited model falls through to the next.
DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
# Raw (Bronze) data is not cleaned or audited yet, so the public chatbot never loads it.
CHAT_NAMESPACES = ("silver", "gold")


def _read_env_file() -> dict[str, str]:
    if not ENV_PATH.exists():
        return {}
    values = {}
    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def _get_llm_config() -> tuple[str, list[str]]:
    # Read on every question, so editing backend/.env needs no restart; real env vars (Docker) are the fallback.
    env = {**os.environ, **_read_env_file()}
    api_key = env.get("GEMINI_API_KEY", "").strip()
    preferred = env.get("GEMINI_MODEL", "").strip()
    models = ([preferred] if preferred else []) + [m for m in DEFAULT_MODELS if m != preferred]
    return api_key, models


TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "run_sql_query",
            "description": (
                "Menjalankan query SQL gaya PostgreSQL (hanya SELECT/WITH) terhadap tabel data kurasi "
                "(silver.*, gold.*) untuk mendapatkan angka pasti, total, ranking, filter, atau rincian APBD Surabaya."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query SQL yang valid (SELECT / WITH). Gunakan LIMIT <= 30 untuk daftar baris.",
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
                "jumlah OPD, jumlah anomali, dan anggaran tematik prioritas."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_vector_knowledge",
            "description": (
                "Pencarian semantik terhadap seluruh dokumen yang siap dicari: PDF, gambar hasil OCR, "
                "halaman web hasil scrape surabaya.go.id, CSV teks, dan ringkasan APBD. Gunakan tool ini untuk mencari topik, "
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


def _ebudgeting_coverage(tables: list[dict[str, Any]]) -> str:
    """eBudgeting usually covers only a few OPDs; the model must know which."""
    if not any(t["name"] == "silver.ebudgeting_rincian" for t in tables):
        return "(belum diunggah)"
    tbl = get_catalog().load_table("silver.ebudgeting_rincian")
    col = tbl.scan(selected_fields=("nama_opd",)).to_arrow().column("nama_opd")
    opds = sorted({str(v).strip() for v in col.to_pylist() if v and str(v).strip()})
    if not opds:
        return "(kosong)"
    names = "; ".join(opds[:15])
    return f"{len(opds)} OPD: {names}" + ("; dst." if len(opds) > 15 else "")


def _build_system_prompt(tables: list[dict[str, Any]], vstats: dict[str, Any]) -> str:
    lines = []
    for t in [t for t in tables if t["layer"] in CHAT_NAMESPACES]:
        cols = ", ".join(f"{c['name']}:{c['type']}" for c in t["columns"][:18])
        ns, name = t["name"].split(".", 1)
        sql_name = f'{ns}."{name}"' if not re.fullmatch(r"[a-z_][a-z0-9_]*", name) else t["name"]
        lines.append(f"- {sql_name} ({t['rows']} baris): {cols}")
    schema_block = "\n".join(lines)

    vector_note = (
        f"aktif, {vstats['totalChunks']} potongan teks dari {len(vstats['sources'])} sumber."
        if vstats["totalChunks"] > 0
        else "masih kosong."
    )

    prompt = f"""Kamu adalah **SuraLake AI**, asisten analis data APBD Kota Surabaya.

Aturan wajib:
1. LANGUAGE: always reply in the same language as the user's latest message. An English question gets a fully English answer. Pertanyaan bahasa Indonesia dijawab dalam bahasa Indonesia. Jawaban harus jelas, ramah, dan mudah dipahami orang non-teknis.
2. **JANGAN PERNAH mengarang atau menebak angka.** Untuk hitungan angka, total, ranking, atau filter tabel, WAJIB panggil `run_sql_query` atau `get_lakehouse_overview`.
3. Untuk pertanyaan tentang isi dokumen PDF, gambar (OCR), hasil scrape web, tautan RKA, atau pencarian topik bebas, panggil `search_vector_knowledge`.
4. Prioritaskan query pada tabel `gold.*` untuk ringkasan OPD/tematik/anomali, dan `silver.*` untuk rincian pekerjaan atau komponen eBudgeting. Untuk angka eBudgeting (komponen, belanja, sub kegiatan) WAJIB pakai `gold.ebudgeting_curated` atau `gold.apbd_subkegiatan_summary`: isinya sudah tahap final (PAK). `silver.ebudgeting_rincian` berisi semua versi (murni, revisi, PAK) dari anggaran yang sama, jadi menjumlahkannya tanpa filter tahap = HITUNG DOBEL. Pakai silver hanya jika pengguna bertanya riwayat per tahap.
5. Hasil tool sudah memberi label Rupiah untuk angka besar, contoh "930250224427 (Rp 930,25 Miliar)". Di jawaban tulis label itu saja (contoh **Rp 930,25 Miliar**), tanpa angka panjangnya kecuali diminta; JANGAN mengonversi Juta/Miliar/Triliun sendiri. 1 Triliun = 1.000 Miliar.
6. Jika data yang ditanyakan tidak ada di tabel di bawah maupun di dokumen, katakan terus terang bahwa datanya belum tersedia.
7. Hanya untuk OPD yang namanya mengandung "RSUD" dan serapan SP2D-nya sangat rendah, beri catatan singkat bahwa RSUD berstatus BLUD sehingga sebagian pencairan tidak melewati mekanisme SP2D reguler.
8. Nilai SP2D/serapan yang kosong (NULL) berarti data pencairan BELUM diunggah, bukan nol.
9. Filter nama OPD memakai ILIKE '%kata kunci%' (contoh: "rs eka candrarini" = nama_opd ILIKE '%eka candrarini%').
10. Pertanyaan belanja barang/pos tertentu (contoh: obat): jika OPD tercakup di silver.ebudgeting_rincian, cari di nama_komponen, nama_detil, nama_rekening (perhatikan tahap). Jika tidak tercakup, cari di silver.monitoring_pekerjaan HANYA pada kolom nama_pekerjaan (nama sub kegiatan menggabungkan beberapa jenis belanja, jadi jangan dipakai untuk total pos), lalu jelaskan bahwa angkanya berdasarkan nama paket pekerjaan. Selalu ambil alokasi_rp, penggunaan_dana_rp, dan sp2d_rp bersama totalnya — pada beberapa paket RSUD/BLUD, alokasi_rp bisa berupa placeholder kecil sementara rencana belanja operasionalnya ada di penggunaan_dana_rp. Sebutkan paket terbesar yang dihitung, dan ingat '%obat%' juga cocok dengan kata seperti "pengobatan".
11. Total WAJIB dihitung database atas SEMUA baris yang cocok, jangan menjumlahkan sendiri baris yang ditampilkan. Untuk daftar sekaligus total, pakai satu query: SELECT nama_pekerjaan, alokasi_rp, penggunaan_dana_rp, sp2d_rp, SUM(alokasi_rp) OVER () AS total_alokasi, SUM(penggunaan_dana_rp) OVER () AS total_penggunaan_dana, SUM(sp2d_rp) OVER () AS total_sp2d, COUNT(*) OVER () AS jumlah_baris_semua FROM ... WHERE ... ORDER BY GREATEST(alokasi_rp, penggunaan_dana_rp) DESC LIMIT 10. Sebutkan jumlah_baris_semua di jawaban.
12. **Aturan OVERBUDGET & Anomali Data (khusus untuk query internal kamu):**
    - `gold.dq_anomaly_audit` HANYA berisi baris yang memiliki catatan anomali (`dq_flag <> ''`). Jangan pernah memakainya untuk total anggaran atau belanja OPD.
    - Di data Monitoring Pemkot, `alokasi_rp` adalah alokasi awal / pagu kontrak paket (pada paket multi-item seperti obat/farmasi RSUD sering berupa angka placeholder Rp 50 Juta), sedangkan `penggunaan_dana_rp` adalah **Rencana Penggunaan Dana** operasional sebenarnya.
    - **JANGAN pernah menyebut paket overbudget hanya karena `sp2d_rp > alokasi_rp` jika `sp2d_rp <= penggunaan_dana_rp`!** Contoh: Alokasi Rp 50 Juta, Penggunaan Dana Rp 7,02 Miliar, SP2D Rp 6,96 Miliar (99,1% dari Penggunaan Dana) → **BUKAN overbudget**.
    - Bedakan dua jenis temuan di `gold.dq_anomaly_audit` saat menyusun query:
      a) `dq_flag = 'OVERBUDGET'`: **Overbudget sungguhan** (`sp2d_rp` melebihi `alokasi_rp` DAN `penggunaan_dana_rp`, yaitu `sp2d_rp > pagu_efektif_rp`).
      b) `dq_flag = 'SP2D_OVER_PENGGUNAAN_DANA'`: **Pencairan melebihi rencana penggunaan dana**, tetapi masih dalam batas `alokasi_rp` (mis. pencairan sekaligus/lebih cepat dari jadwal penggunaan dana).
    - Saat menjawab pertanyaan "apakah ada yang overbudget", WAJIB cek `gold.dq_anomaly_audit` berdasarkan `dq_flag`, tampilkan Alokasi Awal, Rencana Penggunaan Dana, dan Realisasi SP2D secara berdampingan, dan pisahkan jelas antara temuan **Overbudget Sungguhan** dan **Pencairan Melebihi Rencana Penggunaan Dana** (tanpa menulis nama tabel, nama kolom, atau kode `dq_flag` ke pengguna).
13. Pertanyaan lanjutan ("untuk pos belanja obat", "apakah ada yang overbudget") memakai OPD dan konteks dari percakapan sebelumnya.
14. Jika hasil query kosong, coba kata kunci atau tabel lain sebelum menyimpulkan datanya tidak ada.
15. **Gaya Bahasa Publik (WAJIB):** Tulis jawaban dengan teks biasa, tebal, daftar, atau tabel markdown yang ramah pengguna non-teknis. Jangan memakai kutipan (>), jangan menulis tag tool_call, dan **JANGAN PERNAH menyebut nama tabel database (`gold.*`, `silver.*`, `bronze.*`), nama kolom (`alokasi_rp`, `penggunaan_dana_rp`, `sp2d_rp`, `pagu_efektif_rp`, `dq_flag`, dll.), kode flag internal (`OVERBUDGET`, `SP2D_OVER_PENGGUNAAN_DANA`, `FISIK_OVER_100`), ekspresi SQL, atau istilah mesin internal (`Apache Iceberg`, `DuckDB`, `Data Lakehouse`, `Vector Index`, `layer Bronze/Silver/Gold`)** di dalam jawaban akhir — semua nama teknis tersebut hanya untuk query internalmu. Gunakan istilah sehari-hari seperti "data monitoring APBD", "Alokasi Awal", "Rencana Penggunaan Dana", "Realisasi SP2D", dan "Pagu Efektif".
16. Tautan ditulis sebagai link markdown dengan nama singkat, contoh [RKA Kec. Simokerto](https://...), bukan URL panjang. Saat menampilkan daftar dokumen/tautan, tambahkan penjelasan singkat (satu kalimat) tentang isi dokumen berdasarkan judul atau teks tautannya; jangan mengarang isi yang tidak ada di data.

Cakupan silver.ebudgeting_rincian: {_ebudgeting_coverage(tables)}

Pencarian dokumen: {vector_note}

Tabel yang tersedia saat ini (hanya untuk query internalmu):
{schema_block}
"""
    return prompt


def fmt_rupiah(n: float) -> str:
    for size, unit in ((1e12, "Triliun"), (1e9, "Miliar"), (1e6, "Juta")):
        if abs(n) >= size:
            return f"Rp {n / size:,.2f} {unit}".replace(",", "#").replace(".", ",").replace("#", ".")
    return f"Rp {n:,.0f}".replace(",", ".")


_ID_NAME_RE = re.compile(r"(^|_)(id|kode|nomor|no|nik|nip|npwp|tahun)(_|$)|id$|snapshot|sha256", re.IGNORECASE)


def _label_money(value: Any, name: str = "") -> Any:
    """Models misread 12-digit numbers as trillions, so big amounts get a ready-made Rupiah label.

    `name` is the key or column; IDs, codes and years are left alone.
    """
    if isinstance(value, dict):
        if "columns" in value and "rows" in value:
            cols = value["columns"]
            value = {**value, "rows": [[_label_money(v, c) for v, c in zip(r, cols)] for r in value["rows"]]}
        return {k: v if k in ("columns", "rows") else _label_money(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_label_money(v, name) for v in value]
    if isinstance(value, bool) or _ID_NAME_RE.search(name):
        return value
    number = value
    if isinstance(value, str) and re.fullmatch(r"-?\d+(\.\d+)?", value):
        number = float(value)
    if isinstance(number, (int, float)) and abs(number) >= 1e6:
        return f"{value} ({fmt_rupiah(number)})"
    return value


_SOURCE_TAG_RE = re.compile(r"^\[(?:bronze|silver|gold)\.\w+\]\s*")


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return _label_money(_run_tool(name, args))


def _run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    if name == "get_lakehouse_overview":
        ov = get_overview_data()
        if not ov["opd"]:  # zero totals would read as a real "Rp 0"
            return {"catatan": "Ringkasan APBD belum tersedia. Cari angkanya dengan run_sql_query."}
        return {
            "totals": {k: v for k, v in ov["totals"].items() if k != "tableCount"},
            "tematik": ov["tematik"],
            "top_5_opd": ov["opd"][:5],
        }
    if name == "run_sql_query":
        query = str(args.get("query") or "").strip()
        res = run_duckdb_sql(query, allowed_namespaces=CHAT_NAMESPACES)
        # Keep payload compact for LLM context
        return {
            "columns": res["columns"],
            "rows": res["rows"][:40],
            "rowCount": res["rowCount"],
            "rowsShownToYou": min(res["rowCount"], 40),
            "moreRowsExist": res["truncated"] or res["rowCount"] > 40,
            "elapsedMs": res["elapsedMs"],
        }
    if name == "search_vector_knowledge":
        q = str(args.get("query") or "").strip()
        top_k = int(args.get("top_k") or 6)
        hits = search_vectors(q, top_k=min(max(1, top_k), 12))["results"]
        return {"results": [{"text": _SOURCE_TAG_RE.sub("", h["text"]), "score": h["score"]} for h in hits]}
    return {"error": f"Tool tidak dikenal: {name}"}


# Model -> time (monotonic) until which it is skipped. A busy Gemini model can hang for the full
# timeout on every request, so after one failure we skip it for a while instead of paying that again.
_MODEL_COOLDOWN_S = 300
_model_busy_until: dict[str, float] = {}


class QuotaError(RuntimeError):
    """Every model refused because of the provider's rate limit."""


def _call_llm(
    api_key: str,
    models: list[str],
    messages: list[dict[str, Any]],
    use_tools: bool = True,
) -> tuple[dict[str, Any], str]:
    last_err: Exception | None = None
    rate_limited = False
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    now = time.monotonic()
    ready = [m for m in models if _model_busy_until.get(m, 0) <= now] or models
    with httpx.Client(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
        for model in ready:
            payload: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": 0.2,
                # Gemini counts its internal "thinking" against this limit, so leave room.
                "max_tokens": 4000,
            }
            if use_tools:
                payload["tools"] = TOOLS
                payload["tool_choice"] = "auto"
            try:
                resp = client.post(GEMINI_API_URL, headers=headers, json=payload)
                # Any failure moves to the next model. Never retry without tools: the model
                # then writes its tool call as plain text, which the user would see.
                rate_limited = rate_limited or resp.status_code == 429
                if resp.status_code in (429, 500, 502, 503, 504):
                    _model_busy_until[model] = time.monotonic() + _MODEL_COOLDOWN_S
                if resp.status_code >= 400:
                    last_err = RuntimeError(f"Gemini {model} HTTP {resp.status_code}: {resp.text[:300]}")
                    continue
                return resp.json(), model
            except httpx.TransportError as exc:  # timeouts and connection failures
                _model_busy_until[model] = time.monotonic() + _MODEL_COOLDOWN_S
                last_err = exc
                continue
            except Exception as exc:
                last_err = exc
                continue
    error = QuotaError if rate_limited else RuntimeError
    raise error(f"Gagal menghubungi Gemini API: {last_err}")


_TEXT_CALL_RE = re.compile(r"<function=([\w-]+)>(.*?)</function>", re.DOTALL)
_TEXT_PARAM_RE = re.compile(r"<parameter=([\w-]+)>(.*?)</parameter>", re.DOTALL)
_TAG_BLOCK_RE = re.compile(r"<(tool_call|think)>.*?(</\1>|\Z)|<function=.*?(</function>|\Z)", re.DOTALL)
_JSON_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def _parse_text_tool_calls(content: str) -> list[dict[str, Any]]:
    """Some models write tool calls inside the answer text; turn them into real tool calls."""
    found = [
        (name, {k: v.strip() for k, v in _TEXT_PARAM_RE.findall(body)})
        for name, body in _TEXT_CALL_RE.findall(content)
    ]
    for raw in _JSON_CALL_RE.findall(content):
        try:
            data = json.loads(raw)
            found.append((data["name"], data.get("arguments") or {}))
        except (json.JSONDecodeError, KeyError, TypeError):
            continue
    return [
        {"id": f"text_call_{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
        for i, (name, args) in enumerate(found)
    ]


_EN_WORDS = {"there", "any", "can", "you", "what", "how", "which", "the", "is", "are", "of", "much", "many", "and", "total", "budget", "show", "list", "please", "who", "why", "does", "so", "far"}
_ID_WORDS = {"apa", "berapa", "yang", "dan", "di", "untuk", "dari", "anggaran", "dinas", "tolong", "mana", "saja", "ini", "itu", "ada"}


def _is_english(message: str) -> bool:
    words = re.findall(r"[a-z]+", message.lower())
    english = sum(w in _EN_WORDS for w in words)
    return english >= 2 and english > sum(w in _ID_WORDS for w in words)


def _with_language_hint(message: str) -> str:
    """Small models ignore the language rule in the system prompt, so English questions get an explicit nudge."""
    return f"{message}\n\n(Answer in English.)" if _is_english(message) else message


def _not_ready_answer(message: str, has_raw_data: bool) -> str:
    if _is_english(message):
        reason = "the uploaded data has not finished being processed" if has_raw_data else "no data has been uploaded yet"
        return f"Sorry, there is no data ready to analyse yet because {reason}. Please try again later."
    reason = "data yang diunggah belum selesai diproses dan dikurasi" if has_raw_data else "belum ada data yang diunggah"
    return f"Maaf, belum ada data yang siap dianalisis karena {reason}. Silakan coba lagi nanti."


def _clean_answer(content: str) -> str:
    return _TAG_BLOCK_RE.sub("", content).strip()


_PUBLIC_TERMS = {
    "alokasi_rp": "Alokasi Awal",
    "penggunaan_dana_rp": "Rencana Penggunaan Dana",
    "sp2d_rp": "Realisasi SP2D",
    "pagu_efektif_rp": "Pagu Efektif",
    "selisih_overbudget_rp": "Selisih Overbudget",
    "total_realisasi_rp": "Total Realisasi",
    "dq_flag": "catatan data",
    "OVERBUDGET": "Overbudget",
    "SP2D_OVER_PENGGUNAAN_DANA": "Pencairan Melebihi Rencana Penggunaan Dana",
    "FISIK_OVER_100": "Progres Fisik di Atas 100%",
}
# Applied in order. The two snake_case rules catch columns, SQL aliases and flags not listed above.
_PUBLIC_RULES: list[tuple[re.Pattern[str], Any]] = [
    (re.compile(r"```(?:sql)?\s*(?:SELECT|WITH)\b.*?(?:```|\Z)|`\s*(?:SELECT|WITH)\b[^`\n]*`", re.I | re.S), ""),
    (re.compile(r'\b(?:bronze|silver|gold)\.(?:"[^"\n]*"|\*|\w+)|\b__tbl_\w+', re.I), "data APBD"),
    (re.compile(rf"\b(?:{'|'.join(_PUBLIC_TERMS)})\b"), lambda m: _PUBLIC_TERMS[m[0]]),
    # Not before ".ext": file names keep their underscores.
    (re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b(?!\.\w)"), lambda m: m[0].removesuffix("_rp").replace("_", " ")),
    (re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b(?!\.\w)"), lambda m: m[0].replace("_", " ").title()),
    (re.compile(r"\b(?:Apache\s+)?Iceberg\b|\bDuckDB\b|\b(?:Data\s+)?Lakehouse\b", re.I), "sistem data"),
    (re.compile(r"\bVector\s+(?:Index|Search|Store)\b", re.I), "pencarian dokumen"),
    (re.compile(r"\b(?:layer|lapisan|tabel|table)\s+(?:Bronze|Silver|Gold)\b", re.I), "data"),
]
_LINK_RE = re.compile(r"(\]\([^)\s]*\)|https?://[^\s)\]]+)")


def _hide_internals(answer: str) -> str:
    """Rule 15 asks the model not to name internals; this enforces it. Links are left untouched."""
    parts = _LINK_RE.split(answer)
    for i in range(0, len(parts), 2):
        for pattern, replacement in _PUBLIC_RULES:
            parts[i] = pattern.sub(replacement, parts[i])
    return "".join(parts).strip()


def chat_with_lakehouse(
    message: str, history: list[dict[str, str]] | None = None
) -> dict[str, Any]:
    api_key, models = _get_llm_config()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY belum dikonfigurasi di backend/.env.")

    user_msg = message.strip()
    if not user_msg:
        raise ValueError("Pesan tidak boleh kosong.")

    cat = get_catalog_summary()
    vstats = get_vector_stats()
    if not has_curated_data(cat["tables"]) and vstats["totalChunks"] == 0:
        # Answered here: nothing to analyse, so no model call is spent.
        return {
            "answer": _not_ready_answer(user_msg, has_raw_data=any(t["rows"] > 0 for t in cat["tables"])),
            "model": "",
            "sqlUsed": [],
            "snapshotId": None,
        }
    latest_snapshot_id = cat["snapshots"][0]["id"] if cat["snapshots"] else None
    system_prompt = _build_system_prompt(cat["tables"], vstats)
    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for item in (history or [])[-8:]:
        role = item.get("role")
        content = _clean_answer(str(item.get("content") or ""))
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content[:2500]})
    messages.append({"role": "user", "content": _with_language_hint(user_msg)})

    sql_used: list[dict[str, Any]] = []
    used_model = models[0]
    answer = ""
    tool_rounds = 4

    for round_no in range(tool_rounds + 1):
        final_round = round_no == tool_rounds
        if final_round:
            messages.append(
                # Gemini accepts system text only at the start, so this nudge is a user turn.
                {"role": "user", "content": "Jawab sekarang dari data yang sudah ada, tanpa memanggil tool."}
            )
        data, used_model = _call_llm(api_key, models, messages, use_tools=not final_round)
        assistant_msg = data["choices"][0]["message"]
        content = assistant_msg.get("content") or ""
        tool_calls = assistant_msg.get("tool_calls") or _parse_text_tool_calls(content)

        if final_round or not tool_calls:
            answer = _hide_internals(_clean_answer(content))
            break

        # Append assistant tool call request
        messages.append(
            {"role": "assistant", "content": _clean_answer(content), "tool_calls": tool_calls}
        )

        for tc in tool_calls:
            fn = tc.get("function", {})
            fn_name = fn.get("name", "")
            raw_args = fn.get("arguments") or "{}"
            try:
                parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                parsed_args = {}
            if not isinstance(parsed_args, dict):
                parsed_args = {}

            trace = {"query": parsed_args.get("query", ""), "reason": parsed_args.get("reason", "")}
            try:
                tool_out = _execute_tool(fn_name, parsed_args)
                trace.update(rowCount=tool_out.get("rowCount", 0), elapsedMs=tool_out.get("elapsedMs", 0))
            except Exception as exc:
                tool_out = {"error": str(exc)}
                trace["error"] = str(exc)
            if fn_name == "run_sql_query":
                sql_used.append(trace)

            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", "call_0"),
                    # Cap the size so one wide result cannot exceed the model's context.
                    "content": json.dumps(tool_out, ensure_ascii=False, default=str)[:6000],
                }
            )

    return {
        "answer": answer or "Maaf, saya belum bisa menyusun jawaban. Coba persempit pertanyaan kamu.",
        "model": used_model,
        "sqlUsed": sql_used,
        "snapshotId": latest_snapshot_id,
    }
