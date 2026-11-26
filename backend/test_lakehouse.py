"""Run from backend/: .venv/bin/python -m unittest -v  (uses a temporary warehouse)."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
import pyarrow as pa

import chatbot
import lakehouse as L
import vector_store as V

_TMP = tempfile.TemporaryDirectory()
_ROOT = Path(_TMP.name)
for module, names in {
    L: {
        "ROOT_DIR": _ROOT,
        "WAREHOUSE_DIR": _ROOT / "warehouse",
        "ICEBERG_DIR": _ROOT / "warehouse" / "iceberg",
        "RAW_DIR": _ROOT / "warehouse" / "raw",
        "CATALOG_DB": _ROOT / "warehouse" / "catalog.db",
        "INGEST_LOG_PATH": _ROOT / "warehouse" / "ingest_log.json",
    },
    V: {
        "ROOT_DIR": _ROOT,
        "WAREHOUSE_DIR": _ROOT / "warehouse",
        "VECTOR_STORE_PATH": _ROOT / "warehouse" / "vectors.parquet",
    },
}.items():
    for name, value in names.items():
        setattr(module, name, value)


def rows(table: str) -> list[dict]:
    return L._read_table_arrow(L.get_catalog(), table).to_pylist()


class Base(unittest.TestCase):
    def setUp(self):
        L.reset_warehouse()


class Numbers(Base):
    def test_formats(self):
        for text, expected in {
            "1.500.000": 1500000, "1.500": 1500, "1,234.56": 1234.56, "1,234,567": 1234567,
            "Rp 2.000.000,50": 2000000.5, "12,5": 12.5, "0.125": 0.125, "84.10": 84.1, "-": None, "": None,
        }.items():
            self.assertEqual(L._to_float(text), expected, text)
        self.assertEqual(L._parse_fisik_real("84.125 (100.00)"), 84.125)
        self.assertEqual(L._parse_fisik_real("1,252.07 (100.00)"), 1252.07)
        self.assertEqual(L._parse_fisik_real("84,10"), 84.1)

    def test_unreadable_is_an_error_not_zero(self):
        for bad in ("abc", "12abc", "nan"):
            with self.assertRaises(ValueError):
                L._to_float(bad)


class Safety(Base):
    def test_sql_guard(self):
        for ok in ("SELECT 1", "WITH a AS (SELECT 1) SELECT * FROM a;", 'SELECT 1 AS "set"', "SHOW TABLES"):
            L._validate_readonly_sql(ok)
        for bad in ("", "DROP TABLE x", "SELECT 1; SELECT 2", "SELECT 1 --'\n; SELECT 2 --'", "SET threads=1"):
            with self.assertRaises(ValueError, msg=bad):
                L._validate_readonly_sql(bad)
        with self.assertRaises(Exception):
            L.run_duckdb_sql("SELECT * FROM read_csv('/etc/hosts')")

    def test_sql_truncation_and_timeout(self):
        res = L.run_duckdb_sql("SELECT * FROM range(900)")
        self.assertEqual((res["rowCount"], res["truncated"]), (500, True))
        with mock.patch.object(L, "SQL_TIMEOUT_S", 1), self.assertRaisesRegex(ValueError, "dihentikan"):
            L.run_duckdb_sql("SELECT count(*) FROM range(1000000000000) t(i) WHERE i % 7 = 3")

    def test_redirect_to_internal_address_is_never_requested(self):
        seen = []

        def handler(request):
            seen.append(request.url.host)
            return httpx.Response(302, headers={"location": "http://127.0.0.1:9/internal"})

        real = httpx.Client
        with mock.patch.object(
            L.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
        ), self.assertRaises(ValueError):
            L.ingest_web_url("http://93.184.216.34/start")
        self.assertEqual(seen, ["93.184.216.34"])
        with self.assertRaises(ValueError):
            L._validate_public_url("http://100.64.0.1/")


class Tables(Base):
    def test_stale_row_edit_is_refused(self):
        L._write_iceberg_table(L.get_catalog(), "bronze.t", pa.Table.from_pylist([{"n": "A"}, {"n": "B"}]))
        old = L.get_table_rows("bronze", "t")["snapshotId"]
        L.create_table_row("bronze", "t", {"n": "NEW"})
        with self.assertRaises(L.StaleTableError):
            L.delete_table_row("bronze", "t", 0, old)
        page = L.get_table_rows("bronze", "t")
        index = next(r["_row_idx"] for r in page["rows"] if r["n"] == "A")
        L.delete_table_row("bronze", "t", index, page["snapshotId"])
        self.assertEqual(sorted(r["n"] for r in rows("bronze.t")), ["B", "NEW"])

    def test_csv_semicolon_duplicate_headers_and_gold_sums(self):
        L.ingest_uploaded_file("belanja.csv", b"opd;kode;Nilai (Rp);Nilai Rp\nA;001;1.000;1\nA;002;2.500;2\nB;003;;3\n")
        self.assertEqual(rows("bronze.belanja_raw")[0]["nilai_rp_2"], "1")
        L.promote_bronze_to_silver("bronze.belanja_raw")
        self.assertEqual(rows("silver.belanja_clean")[0]["kode"], "001")
        L.promote_silver_to_gold("silver.belanja_clean")
        gold = {r["opd"]: r for r in rows("gold.belanja_summary")}
        self.assertEqual((gold["A"]["total_nilai_rp"], gold["A"]["total_nilai_rp_2"]), (3500, 3))

    def test_reupload_replaces_instead_of_duplicating(self):
        for _ in range(2):
            L.ingest_uploaded_file("pic.png", b"not really an image")
        self.assertEqual(len(rows("bronze.media_assets_raw")), 1)
        with self.assertRaises(ValueError):
            L.ingest_uploaded_file("old.xls", b"x")

    def test_missing_payments_are_null_and_each_opd_keeps_its_stage(self):
        row = dict(
            kode_detail_kegiatan="", kode_sub_kegiatan="1", nama_sub_kegiatan="s", nama_subtitle="",
            nama_komponen="obat", nama_detil="", satuan="", volume=1.0, koefisien="", harga_satuan_rp=1,
            pajak_pct=0.0, anggaran_rasionalisasi_rp=0, sumber_dana="", rekening="", nama_rekening="",
            is_pendidikan=False, is_kesehatan=True, is_infrastruktur=False, is_stunting=False,
            is_miskin=False, is_inflasi=False,
        )
        data = [
            {**row, "nama_opd": "A", "tahap": "murni", "hasil_rp": 10},
            {**row, "nama_opd": "A", "tahap": "pak", "hasil_rp": 20},
            {**row, "nama_opd": "B", "tahap": "murni", "hasil_rp": 5},
        ]
        L._write_iceberg_table(L.get_catalog(), "silver.ebudgeting_rincian", pa.Table.from_pylist(data))
        L.rebuild_gold()
        opd = {r["nama_opd"]: r for r in rows("gold.apbd_opd_summary")}
        self.assertEqual((opd["A"]["alokasi_rp"], opd["B"]["alokasi_rp"]), (20, 5))
        self.assertIsNone(opd["A"]["sp2d_rp"])
        self.assertIsNone(L.get_overview_data()["totals"]["serapanPct"])

    def test_gold_rewrite_removes_old_vectors_and_audit_rows(self):
        base = dict(
            nama_opd="A", kode_sub_kegiatan="1", nama_sub_kegiatan="s", id_pekerjaan="1", nama_pekerjaan="p",
            alokasi_rp=100, penggunaan_dana_rp=0, rencana_fisik_pct=1.0, total_realisasi_rp=0, sp2d_rp=500,
            dq_flag="SP2D_OVER_ALOKASI",
        )
        L._write_iceberg_table(L.get_catalog(), "silver.monitoring_pekerjaan", pa.Table.from_pylist([base]))
        L.rebuild_gold()
        V._write_vectors([{"chunk_id": "x", "source": "gold.dq_anomaly_audit", "layer": "gold", "text": "old", "embedding": [1.0]}])
        snapshot = L.get_table_rows("silver", "monitoring_pekerjaan")["snapshotId"]
        L.update_table_row("silver", "monitoring_pekerjaan", 0, {"sp2d_rp": 50, "dq_flag": ""}, snapshot)
        self.assertEqual(rows("gold.dq_anomaly_audit"), [])
        self.assertEqual(V._read_existing_vectors(), [])


class Vectors(Base):
    def test_every_row_is_indexed(self):
        table = pa.Table.from_pylist([{"nama": f"item {i}"} for i in range(900)])
        self.assertEqual(len(V._build_chunks_for_table("gold.big", table)), 900)


class Chat(Base):
    TEXT_CALL = (
        "<tool_call>\n<function=run_sql_query>\n<parameter=query>\nSELECT 42 AS n\n</parameter>\n"
        "<parameter=reason>\ntes\n</parameter>\n</function>\n</tool_call>"
    )

    def ask(self, replies):
        queue = iter(replies)
        fake = lambda *a, **k: ({"choices": [{"message": {"content": next(queue)}}]}, "m")
        with mock.patch.object(chatbot, "_call_groq", fake), mock.patch.object(
            chatbot, "_get_groq_config", lambda: ("key", ["m"])
        ):
            return chatbot.chat_with_lakehouse("obat?")

    def test_tool_call_written_as_text_is_executed(self):
        res = self.ask([self.TEXT_CALL, "Totalnya 42."])
        self.assertEqual(res["answer"], "Totalnya 42.")
        self.assertEqual(res["sqlUsed"][0]["rowCount"], 1)

    def test_tool_markup_never_reaches_the_user(self):
        res = self.ask([self.TEXT_CALL] * 5)
        self.assertNotIn("<", res["answer"])
        json.dumps(res)


if __name__ == "__main__":
    unittest.main()
