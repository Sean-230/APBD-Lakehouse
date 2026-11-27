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


class QaRegressions(Base):
    def test_table_name_starting_with_a_digit_keeps_sql_working(self):
        L.ingest_uploaded_file("2026 Data Hibah.csv", b"penerima,nilai\nX,1000\nY,2000\n")
        self.assertEqual(L.run_duckdb_sql("SELECT 1")["rows"], [["1"]])
        self.assertEqual(L.run_duckdb_sql('SELECT count(*) FROM bronze."2026_data_hibah_raw"')["rows"], [["2"]])

    def test_editing_a_csv_row_updates_its_gold_and_keeps_other_vectors(self):
        L.ingest_uploaded_file("belanja.csv", b"opd,nilai\nA,10\nB,20\n")
        L.promote_bronze_to_silver("bronze.belanja_raw")
        L.promote_silver_to_gold("silver.belanja_clean")
        L._write_iceberg_table(L.get_catalog(), "gold.other", pa.Table.from_pylist([{"x": 1}]))
        V._write_vectors([{"chunk_id": "k", "source": "gold.other", "layer": "gold", "text": "t", "embedding": [1.0]}])
        page = L.get_table_rows("silver", "belanja_clean")
        index = next(r["_row_idx"] for r in page["rows"] if r["opd"] == "A")
        L.update_table_row("silver", "belanja_clean", index, {"nilai": 99}, page["snapshotId"])
        gold = {r["opd"]: r["total_nilai"] for r in rows("gold.belanja_summary")}
        self.assertEqual(gold["A"], 99)
        self.assertEqual([r["source"] for r in V._read_existing_vectors()], ["gold.other"])

    def test_rewriting_unchanged_gold_keeps_snapshot(self):
        data = pa.Table.from_pylist([{"x": 1}])
        first = L._write_iceberg_table(L.get_catalog(), "gold.same", data)
        self.assertEqual(L._write_iceberg_table(L.get_catalog(), "gold.same", data)["snapshot_id"], first["snapshot_id"])

    def test_only_select_can_be_saved_as_gold(self):
        with self.assertRaises(ValueError):
            L.save_sql_as_gold("DESCRIBE SELECT 1", "x")
        self.assertEqual(L.save_sql_as_gold("SELECT 1 AS a", "ok")["table"], "gold.ok")

    def test_money_labels(self):
        self.assertEqual(chatbot.fmt_rupiah(491558472638), "Rp 491,56 Miliar")
        self.assertEqual(chatbot.fmt_rupiah(9586156578193), "Rp 9,59 Triliun")
        out = chatbot._label_money({"columns": ["id_x", "alokasi_rp"], "rows": [["12345678", "930250224427"]]})
        self.assertEqual(out["rows"][0], ["12345678", "930250224427 (Rp 930,25 Miliar)"])

    def test_rare_query_words_outrank_common_ones(self):
        texts = ["anggaran BOS sekolah"] * 500 + ["Gambar OCR Anggaran Posyandu 2026"]
        scores = V._keyword_scores("anggaran posyandu", texts)
        self.assertEqual(int(scores.argmax()), 500)

    def test_monitoring_dq_flags_distinguish_overbudget_and_penggunaan_dana(self):
        raw = [
            # Normal BLUD package: placeholder alokasi 50jt, real plan 7.02M, SP2D 6.96M (99.1%) -> CLEAN
            {
                "perangkat_daerah": "RSUD Eka Candrarini",
                "id_sub_kegiatan_raw": "1 02 02 2 02 0001 (10)",
                "nama_sub_kegiatan_raw": "Pelayanan Kesehatan (PPKm: dr. A)",
                "id_pakerjaan": "1",
                "nama_pakerjaan": "Belanja Obat 1 RSUD Eka Candrarini",
                "metode_pekerjaan": "e-Purchasing",
                "alokasi_rp": 50_000_000,
                "penggunaan_dana_rp": 7_021_307_828,
                "rencana_fisik_pct": "14,042.62",
                "realisasi_fisik_pct": "99.06 (99.06)",
                "total_realisasi_rp": 6_955_290_699,
                "sp2d_rp": 6_955_290_699,
                "rekanan": "",
                "nilai_kontrak_rp": 0,
                "_periode_raw": "2026",
            },
            # True overbudget: SP2D exceeds BOTH alokasi (50jt) and penggunaan_dana (722.44jt)
            {
                "perangkat_daerah": "RSUD Eka Candrarini",
                "id_sub_kegiatan_raw": "1 02 02 2 02 0001 (10)",
                "nama_sub_kegiatan_raw": "Pelayanan Kesehatan (PPKm: dr. A)",
                "id_pakerjaan": "2",
                "nama_pakerjaan": "Belanja Bahan Kimia Kefarmasian 1",
                "metode_pekerjaan": "e-Purchasing",
                "alokasi_rp": 50_000_000,
                "penggunaan_dana_rp": 722_440_658,
                "rencana_fisik_pct": "1,444.88",
                "realisasi_fisik_pct": "100.00",
                "total_realisasi_rp": 862_127_502,
                "sp2d_rp": 862_127_502,
                "rekanan": "",
                "nilai_kontrak_rp": 0,
                "_periode_raw": "2026",
            },
            # SP2D above penggunaan_dana but still within alokasi -> SP2D_OVER_PENGGUNAAN_DANA
            {
                "perangkat_daerah": "RSUD Eka Candrarini",
                "id_sub_kegiatan_raw": "1 02 02 2 02 0001 (10)",
                "nama_sub_kegiatan_raw": "Pelayanan Kesehatan (PPKm: dr. A)",
                "id_pakerjaan": "3",
                "nama_pakerjaan": "Pengadaan CT Scan 128 Slice",
                "metode_pekerjaan": "e-Purchasing",
                "alokasi_rp": 14_400_000_000,
                "penggunaan_dana_rp": 1_050_000_000,
                "rencana_fisik_pct": "7.29",
                "realisasi_fisik_pct": "100.00",
                "total_realisasi_rp": 14_400_000_000,
                "sp2d_rp": 14_400_000_000,
                "rekanan": "",
                "nilai_kontrak_rp": 14_400_000_000,
                "_periode_raw": "2026",
            },
            # True physical progress > 100%
            {
                "perangkat_daerah": "Dinas Kesehatan",
                "id_sub_kegiatan_raw": "1 02 02 2 01 0001 (11)",
                "nama_sub_kegiatan_raw": "Layanan Dasar",
                "id_pakerjaan": "4",
                "nama_pakerjaan": "Paket Fisik Lebih",
                "metode_pekerjaan": "Tender",
                "alokasi_rp": 100_000_000,
                "penggunaan_dana_rp": 100_000_000,
                "rencana_fisik_pct": "100.00",
                "realisasi_fisik_pct": "105.50",
                "total_realisasi_rp": 90_000_000,
                "sp2d_rp": 90_000_000,
                "rekanan": "",
                "nilai_kontrak_rp": 0,
                "_periode_raw": "2026",
            },
        ]
        L._write_iceberg_table(L.get_catalog(), "bronze.monitoring_pd_raw", pa.Table.from_pylist(raw))
        L.promote_bronze_to_silver("bronze.monitoring_pd_raw")
        L.rebuild_gold()

        silver_by_id = {r["id_pekerjaan"]: r for r in rows("silver.monitoring_pekerjaan")}
        self.assertEqual(silver_by_id["1"]["dq_flag"], "")
        self.assertEqual(silver_by_id["2"]["dq_flag"], "OVERBUDGET")
        self.assertEqual(silver_by_id["3"]["dq_flag"], "SP2D_OVER_PENGGUNAAN_DANA")
        self.assertEqual(silver_by_id["4"]["dq_flag"], "FISIK_OVER_100")

        audit = rows("gold.dq_anomaly_audit")
        self.assertEqual([r["id_pekerjaan"] for r in audit], ["2", "3", "4"])
        self.assertEqual(audit[0]["pagu_efektif_rp"], 722_440_658)
        self.assertEqual(audit[0]["selisih_overbudget_rp"], 862_127_502 - 722_440_658)

    def test_subkegiatan_summary_preserves_all_opds_when_both_sources_exist(self):
        mon = [
            {
                "nama_opd": "Dinas Pendidikan",
                "kode_sub_kegiatan": "1.01.02.2.01.0001",
                "nama_sub_kegiatan": "Pengelolaan SD",
                "id_pekerjaan": "1",
                "nama_pekerjaan": "BOS SD",
                "alokasi_rp": 1_000_000,
                "penggunaan_dana_rp": 900_000,
                "rencana_fisik_pct": 90.0,
                "realisasi_fisik_pct": 80.0,
                "total_realisasi_rp": 800_000,
                "sp2d_rp": 800_000,
                "dq_flag": "",
            },
            {
                "nama_opd": "Dinas Kesehatan",
                "kode_sub_kegiatan": "1.02.02.2.01.0001",
                "nama_sub_kegiatan": "Layanan Puskesmas",
                "id_pekerjaan": "2",
                "nama_pekerjaan": "Operasional Puskesmas",
                "alokasi_rp": 2_000_000,
                "penggunaan_dana_rp": 1_500_000,
                "rencana_fisik_pct": 75.0,
                "realisasi_fisik_pct": 60.0,
                "total_realisasi_rp": 1_200_000,
                "sp2d_rp": 1_200_000,
                "dq_flag": "",
            },
        ]
        eb = [
            {
                "nama_opd": "Dinas Pendidikan",
                "kode_detail_kegiatan": "d1",
                "kode_sub_kegiatan": "1.01.02.2.01.0001",
                "nama_sub_kegiatan": "Pengelolaan SD",
                "nama_subtitle": "BOS",
                "nama_komponen": "Buku",
                "nama_detil": "",
                "satuan": "paket",
                "volume": 1.0,
                "koefisien": "1",
                "harga_satuan_rp": 1_000_000,
                "pajak_pct": 0.0,
                "hasil_rp": 1_000_000,
                "anggaran_rasionalisasi_rp": 1_000_000,
                "sumber_dana": "DAK Non Fisik",
                "rekening": "5.1",
                "nama_rekening": "Belanja Barang",
                "tahap": "PAK",
                "is_pendidikan": True,
                "is_kesehatan": False,
                "is_infrastruktur": False,
                "is_stunting": False,
                "is_miskin": False,
                "is_inflasi": False,
            }
        ]
        L._write_iceberg_table(L.get_catalog(), "silver.monitoring_pekerjaan", pa.Table.from_pylist(mon))
        L._write_iceberg_table(L.get_catalog(), "silver.ebudgeting_rincian", pa.Table.from_pylist(eb))
        L.rebuild_gold()

        sub = {r["nama_opd"]: r for r in rows("gold.apbd_subkegiatan_summary")}
        self.assertEqual(set(sub.keys()), {"Dinas Pendidikan", "Dinas Kesehatan"})
        self.assertEqual(sub["Dinas Kesehatan"]["total_anggaran_rp"], 2_000_000)
        self.assertEqual(sub["Dinas Kesehatan"]["total_sp2d_rp"], 1_200_000)
        self.assertEqual(sub["Dinas Pendidikan"]["sumber_dana"], "DAK Non Fisik")
        self.assertEqual(sub["Dinas Pendidikan"]["jumlah_komponen"], 1)

    def test_web_scraper_resolves_relative_links(self):
        html = '<html><head><title>Dokumen</title></head><body><a href="/files/rka-dinkes.pdf">RKA Dinkes</a></body></html>'
        real = httpx.Client

        def handler(request):
            return httpx.Response(200, text=html, headers={"content-type": "text/html"})

        with mock.patch.object(
            L.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
        ):
            L.ingest_web_url("http://93.184.216.34/portal/index.html")
        saved = rows("bronze.web_harvest_raw")
        self.assertEqual(saved[0]["link_href"], "http://93.184.216.34/files/rka-dinkes.pdf")

    def test_promote_empty_monitoring_raises_clean_error(self):
        L._write_iceberg_table(
            L.get_catalog(),
            "bronze.monitoring_pd_raw",
            pa.Table.from_pylist([{"perangkat_daerah": ""}]),
        )
        with self.assertRaises(ValueError):
            L.promote_bronze_to_silver("bronze.monitoring_pd_raw")

    def test_vector_score_bounded_and_excludes_dq_audit(self):
        L._write_iceberg_table(L.get_catalog(), "gold.apbd_opd_summary", pa.Table.from_pylist([{"nama_opd": "Dinas Kesehatan", "alokasi_rp": 100}]))
        L._write_iceberg_table(L.get_catalog(), "gold.dq_anomaly_audit", pa.Table.from_pylist([{"nama_opd": "Dinas Kesehatan", "dq_flag": "OVERBUDGET"}]))

        class FakeEmbedder:
            def embed(self, texts, batch_size=32):
                return [[1.0, 0.0, 0.0] for _ in texts]

        with mock.patch.object(V, "_get_embedder", lambda: FakeEmbedder()):
            rebuilt = V.rebuild_all_vectors()
            self.assertEqual(rebuilt["tablesIndexed"], ["gold.apbd_opd_summary"])
            res = V.search_vectors("Dinas Kesehatan", top_k=5)
            self.assertEqual(len(res["results"]), 1)
            self.assertLessEqual(res["results"][0]["score"], 1.0)
            self.assertGreaterEqual(res["results"][0]["score"], 0.0)


class ModelFallback(unittest.TestCase):
    def test_busy_model_is_skipped_on_the_next_call(self):
        calls = []

        def handler(request):
            model = json.loads(request.content)["model"]
            calls.append(model)
            if model == "busy":
                raise httpx.ReadTimeout("hang")
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        real = httpx.Client
        chatbot._model_busy_until.clear()
        with mock.patch.object(chatbot.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)):
            chatbot._call_llm("k", ["busy", "good"], [])
            chatbot._call_llm("k", ["busy", "good"], [])
        self.assertEqual(calls, ["busy", "good", "good"])


class Language(unittest.TestCase):
    def test_english_questions_get_a_hint(self):
        self.assertTrue(chatbot._with_language_hint("What is the total budget of Dinas Kesehatan?").endswith("(Answer in English.)"))
        self.assertEqual(chatbot._with_language_hint("berapa anggaran dinas kesehatan"), "berapa anggaran dinas kesehatan")
        self.assertEqual(chatbot._with_language_hint("total anggaran dinas pendidikan"), "total anggaran dinas pendidikan")


class Vectors(Base):
    def test_every_row_is_indexed(self):
        table = pa.Table.from_pylist([{"nama": f"item {i}"} for i in range(900)])
        self.assertEqual(len(V._build_chunks_for_table("gold.big", table)), 900)


class ChatbotBoundary(Base):
    def setUp(self):
        super().setUp()
        self.bronze = pa.Table.from_pylist([{"nama_opd": "Dinas Kesehatan", "alokasi_rp": 987654321}])
        L._write_iceberg_table(L.get_catalog(), "bronze.monitoring_pd_raw", self.bronze)

    def test_chat_sql_cannot_reach_bronze(self):
        L._write_iceberg_table(L.get_catalog(), "silver.ok", pa.Table.from_pylist([{"x": 1}]))
        allowed = ("silver", "gold")
        with self.assertRaisesRegex(Exception, "does not exist"):
            L.run_duckdb_sql("SELECT * FROM bronze.monitoring_pd_raw", allowed_namespaces=allowed)
        listed = L.run_duckdb_sql(
            "SELECT * FROM information_schema.tables WHERE table_schema = 'bronze'", allowed_namespaces=allowed
        )
        self.assertEqual(listed["rowCount"], 0)
        self.assertEqual(L.run_duckdb_sql("SELECT x FROM silver.ok", allowed_namespaces=allowed)["rows"], [["1"]])
        with self.assertRaisesRegex(Exception, "does not exist"):
            chatbot._execute_tool("run_sql_query", {"query": "SELECT * FROM bronze.monitoring_pd_raw"})

    def test_admin_sql_still_reads_bronze(self):
        res = L.run_duckdb_sql("SELECT alokasi_rp FROM bronze.monitoring_pd_raw")
        self.assertEqual(res["rows"], [["987654321"]])
        self.assertEqual(L.save_sql_as_gold("SELECT * FROM bronze.monitoring_pd_raw", "dari_bronze")["table"], "gold.dari_bronze")

    def test_metadata_queries_show_no_internal_names(self):
        for query in (
            "SHOW TABLES",
            "SHOW ALL TABLES",
            "SELECT * FROM information_schema.tables",
            "SELECT table_name FROM duckdb_tables() UNION ALL SELECT view_name FROM duckdb_views()",
        ):
            self.assertNotIn("__tbl", str(L.run_duckdb_sql(query)["rows"]), query)
        self.assertEqual(L.run_duckdb_sql("SHOW TABLES")["rows"], [])

    def test_raw_only_or_empty_warehouse_answers_without_the_model(self):
        self.assertFalse(L.get_overview_data()["readyForAnalysis"])

        def no_model(*a, **k):
            raise AssertionError("the model must not be called")

        def ask(question):
            with mock.patch.object(chatbot, "_call_llm", no_model), mock.patch.object(
                chatbot, "_get_llm_config", lambda: ("key", ["m"])
            ):
                return chatbot.chat_with_lakehouse(question)

        res = ask("Berapa anggaran Dinas Kesehatan?")
        self.assertIn("belum selesai diproses", res["answer"])
        self.assertEqual(res["sqlUsed"], [])
        self.assertNotRegex(res["answer"], r"(?i)\d|bronze|silver|gold|iceberg|duckdb|lakehouse|monitoring|_rp")
        self.assertIn("no data ready", ask("What is the total budget of Dinas Kesehatan?")["answer"])
        L.reset_warehouse()
        self.assertIn("belum ada data yang diunggah", ask("Berapa anggaran Dinas Kesehatan?")["answer"])

    def test_curated_data_makes_the_chat_ready(self):
        L._write_iceberg_table(L.get_catalog(), "silver.ok", pa.Table.from_pylist([{"x": 1}]))
        self.assertTrue(L.get_overview_data()["readyForAnalysis"])
        self.assertNotIn("totals", chatbot._execute_tool("get_lakehouse_overview", {}))
        prompt = chatbot._build_system_prompt(L.get_catalog_summary()["tables"], V.get_vector_stats())
        self.assertIn("silver.ok", prompt)
        self.assertNotIn("bronze.monitoring_pd_raw", prompt)

    def test_search_results_carry_no_table_names(self):
        hit = {"chunkId": "k", "source": "gold.x", "layer": "gold", "score": 0.5, "text": "[gold.x] nama: A"}
        with mock.patch.object(chatbot, "search_vectors", lambda *a, **k: {"results": [hit]}):
            out = chatbot._execute_tool("search_vector_knowledge", {"query": "a"})
        self.assertEqual(out, {"results": [{"text": "nama: A", "score": 0.5}]})

    def test_internal_names_are_removed_from_answers(self):
        leaky = (
            "Dari `gold.dq_anomaly_audit` dan __tbl_bronze_monitoring_pd_raw: sp2d_rp > pagu_efektif_rp, "
            "dq_flag = 'OVERBUDGET', SP2D_OVER_PENGGUNAAN_DANA, SP2D_OVER_ALOKASI, total_alokasi, "
            'silver."2026_x". Apache Iceberg, DuckDB, Data Lakehouse, Vector Index, layer Bronze.\n'
            "```sql\nSELECT * FROM gold.apbd_opd_summary\n```"
        )
        self.assertNotRegex(
            chatbot._hide_internals(leaky),
            r"(?i)gold|silver|bronze|__tbl|\w_\w|iceberg|duckdb|lakehouse|vector|select",
        )
        fine = (
            "**Rp 7,02 Miliar** (Overbudget) harga emas gold. [RKA_Dinkes.pdf](https://x.id/a_b/gold.pdf) "
            "https://x.id/rka_2026 SuraLake"
        )
        self.assertEqual(chatbot._hide_internals(fine), fine)


class Chat(Base):
    TEXT_CALL = (
        "<tool_call>\n<function=run_sql_query>\n<parameter=query>\nSELECT 42 AS n\n</parameter>\n"
        "<parameter=reason>\ntes\n</parameter>\n</function>\n</tool_call>"
    )

    def setUp(self):
        super().setUp()  # without curated data the chat answers before calling the model
        L._write_iceberg_table(L.get_catalog(), "silver.t", pa.Table.from_pylist([{"x": 1}]))

    def ask(self, replies):
        queue = iter(replies)
        fake = lambda *a, **k: ({"choices": [{"message": {"content": next(queue)}}]}, "m")
        with mock.patch.object(chatbot, "_call_llm", fake), mock.patch.object(
            chatbot, "_get_llm_config", lambda: ("key", ["m"])
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
