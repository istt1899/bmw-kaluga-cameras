# SPDX-License-Identifier: GPL-3.0-or-later
"""Independent small-workbook regressions for the host-only police importer."""
import hashlib
import importlib.util
import io
import json
import sys
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("gibdd_import", Path(__file__).with_name("import-gibdd-kaluga.py"))
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)
STAMP = "2026-11-07T08:55:26Z"


def workbook(fixed=None, shared=False, formula=False):
    if fixed is None:
        fixed = [
            (3, "Калуга, пример перекрёстка", "54.517579, 36.248671", "Круглосуточно Встречное/ попутное",
             "Превышение скорости, Нарушение правил приминения ремней безопасности или мотошлемов, "
             "Несоблюдение требований, предписанных дорожными знаками или разметкой проезжей части дороги, "
             "Проезд на запрещающий сигнал светофора, Не выполнение требования правил дорожного движения об остановке перед стоп-линией"),
            (4, "Некорректная исходная долгота", "54.583501, 36253101", "Круглосуточно", "Превышение скорости"),
            (5, "Два явно указанных рубежа", "55.005046, 36.43752 55.005196, 36.437532", "09.30-20.00 Встречное/ попутное", "Превышение скорости"),
        ]
    rows = [(1, "Стационарные и передвижные средства фиксации"),
            (2, "Адрес рубежа", "Географические координаты", "Контролируемые условия и режимы движения", "Фиксируемые нарушения")]
    rows += fixed
    rows += [(160, "Мобильные средства фиксации"),
             (161, "Маршрут движения (траектория с указанием начальных, промежуточных и конечных точек географических координат)", "Контролируемые условия и режимы движения", "Виды выявленных нарушений правил дорожного движения"),
             (162, "Калуга, пример маршрута (54.51, 36.24; 54.52, 36.25; 54.53, 36.26)", "08.00-17.00 при движении в попутном направлении", "Остановка запрещена")]
    xml_rows, strings = [], []
    for row in rows:
        cells = []
        for index, value in enumerate(row[1:]):
            ref = chr(65 + index) + str(row[0])
            if shared:
                strings.append(value)
                cells.append('<c r="' + ref + '" t="s"><v>' + str(len(strings) - 1) + '</v></c>')
            else:
                cells.append('<c r="' + ref + '" t="inlineStr"><is><t>' + escape(value) + '</t></is></c>')
        if formula and row[0] == 3:
            cells.append('<c r="E3"><f>1+1</f><v>2</v></c>')
        xml_rows.append('<row r="' + str(row[0]) + '">' + ''.join(cells) + '</row>')
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="' + IMPORTER.NS["s"] + '"><sheetData>' + ''.join(xml_rows) + '</sheetData></worksheet>')
        if shared:
            archive.writestr("xl/sharedStrings.xml", '<sst xmlns="' + IMPORTER.NS["s"] + '">' + ''.join('<si><t>' + escape(s) + '</t></si>' for s in strings) + '</sst>')
    return output.getvalue()


class PoliceImportTests(unittest.TestCase):
    def test_sections_coordinates_unknowns_and_provenance(self):
        payload = workbook()
        result = IMPORTER.import_workbook(payload, STAMP)
        self.assertEqual(result["sourceSha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(result["audit"]["fixedRows"], 3)
        self.assertEqual(result["audit"]["acceptedRows"], 2)
        self.assertEqual(len(result["records"]), 3)
        self.assertEqual(result["audit"]["multipleCoordinateRows"], [5])
        self.assertEqual(result["audit"]["rejected"][0]["coordinatesRaw"], "54.583501, 36253101")
        self.assertEqual(result["audit"]["mobileRoutes"], 1)
        self.assertEqual(result["audit"]["mobileRoutePointMentions"], 3)
        self.assertFalse(result["audit"]["mobileRouteRecords"][0]["importAsFixedCamera"])
        crossing = next(r for r in result["records"] if r["sourceRow"] == 3)
        self.assertEqual(crossing["position"], {"lat": 54.517579, "lon": 36.248671})
        self.assertEqual(set(crossing["controls"]), {"speed", "belt", "redlight", "stopline", "signs_marking"})
        for record in result["records"]:
            self.assertEqual(record["captureSide"], "unknown")
            self.assertIsNone(record["limitKmh"])
            self.assertIsNone(record["bearingDeg"])
            self.assertIsNone(record["hardwareModel"])
            self.assertEqual(record["sourceUrl"], IMPORTER.SOURCE_URL)
            self.assertEqual(record["positionKind"], "official-location")

    def test_shared_strings_and_inline_have_same_observations(self):
        inline = IMPORTER.import_workbook(workbook(), STAMP)
        shared = IMPORTER.import_workbook(workbook(shared=True), STAMP)
        self.assertEqual(inline["records"], shared["records"])

    def test_id_stable_under_row_reorder_but_preserves_distinct_conditions(self):
        one = [(3, "Одинаковый адрес", "54.5, 36.2", "Круглосуточно", "Превышение скорости"),
               (4, "Одинаковый адрес", "54.5, 36.2", "09.30-20.00", "Превышение скорости")]
        two = [(103, *one[1][1:]), (104, *one[0][1:])]
        first = IMPORTER.import_workbook(workbook(one), STAMP)
        second = IMPORTER.import_workbook(workbook(two), STAMP)
        self.assertEqual({r["id"] for r in first["records"]}, {r["id"] for r in second["records"]})
        self.assertEqual(len({r["id"] for r in first["records"]}), 2)
        with self.assertRaisesRegex(ValueError, "DUPLICATE_OBSERVATION"):
            IMPORTER.import_workbook(workbook([one[0], (4, *one[0][1:])]), STAMP)

    def test_never_repairs_source_coordinates(self):
        for raw in ["54.583501, 36253101", "54.5, 36.2 extra", "54.5,36.2 100", "0.1,0.2"]:
            positions, error = IMPORTER.parse_positions(raw)
            self.assertEqual(positions, [])
            self.assertIsNotNone(error)
        positions, error = IMPORTER.parse_positions("54.358913 35.613404")
        self.assertIsNone(error)
        self.assertEqual(positions[0]["lon"], 35.613404)

    def test_broad_legal_categories_do_not_become_specific_lane_or_phone(self):
        raw = "Нарушение правил расположения транспортного средства на проезжей части дороги, встречного разъезда или обгона, Движение по обочине"
        controls, _, remainder = IMPORTER.parse_controls(raw)
        self.assertEqual(controls, ["road_position"])
        self.assertIn("Движение по обочине", remainder)
        self.assertNotIn("lane", controls)
        self.assertNotIn("phone", controls)

    def test_no_workbook_evaluation_and_bounded_input(self):
        with self.assertRaisesRegex(ValueError, "FORMULA"):
            IMPORTER.import_workbook(workbook(formula=True), STAMP)
        with self.assertRaisesRegex(ValueError, "XLSX_SIZE"):
            IMPORTER.worksheet_rows(b"x" * (IMPORTER.MAX_XLSX_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "TIMEZONE"):
            IMPORTER.import_workbook(workbook(), "2026-11-07T08:55:26")

    def test_future_source_metadata_is_explicit_and_official_host_only(self):
        url = IMPORTER.INDEX_URL.rsplit("/r/40", 1)[0] + "/upload/site40/report/publication/file/sayt_noyabr.xlsx"
        result = IMPORTER.import_workbook(workbook(), STAMP, "2026-11-01", None, url)
        self.assertEqual(result["sourceUrl"], url)
        self.assertEqual(result["publishedAt"], "2026-11-01")
        self.assertIsNone(result["sourceLastModified"])
        self.assertTrue(all(r["sourceUrl"] == url and r["sourcePublishedAt"] == "2026-11-01" for r in result["records"]))
        for rejected in [url.replace("https:", "http:"), url.replace("xn--80aebkobnwfcnsfk1e0h.xn--p1ai", "gov-gibdd.ru"),
                         url + "?token=unexpected", url.replace("file/", "file/../"),
                         url.replace("file/", "file/%2e%2e%2f"), url.replace("/site40/", "/site77/")]:
            with self.assertRaises(ValueError):
                IMPORTER.validate_source_url(rejected)

    def test_checked_in_capture_matches_original_source_facts(self):
        reference = Path(__file__).parent.parent / "data/references/gibdd-kaluga-2026-10-01.json"
        facts = json.loads(reference.read_text(encoding="utf-8"))
        snapshot = reference.parent.parent / "source-snapshots/gibdd-kaluga-2026-10-01.xlsx"
        rebuilt = IMPORTER.import_workbook(snapshot.read_bytes(), facts["retrievedAt"], facts["publishedAt"], facts["sourceLastModified"])
        self.assertEqual(rebuilt, facts, "Archived government XLSX must reproduce every normalized source fact")
        self.assertEqual(facts["sourceSha256"], "a62b2858aecdbeb63e43445b556c9db9d6c628e674c9e96fb5a5a01074d16089")
        self.assertEqual(facts["audit"]["fixedRows"], 155)
        self.assertEqual(facts["audit"]["acceptedRows"], 153)
        self.assertEqual(len(facts["records"]), 155)
        self.assertEqual(facts["audit"]["mobileRoutes"], 184)
        self.assertEqual({r["sourceRow"] for r in facts["audit"]["rejected"]}, {110, 111})
        self.assertEqual(len({r["id"] for r in facts["records"]}), 155)
        for record in facts["records"]:
            self.assertTrue(53 <= record["position"]["lat"] <= 56)
            self.assertTrue(33 <= record["position"]["lon"] <= 38)
            self.assertIsNone(record["limitKmh"])
            self.assertEqual(record["captureSide"], "unknown")


if __name__ == "__main__":
    unittest.main()
