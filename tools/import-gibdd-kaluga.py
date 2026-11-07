# SPDX-License-Identifier: GPL-3.0-or-later
"""Host-only, standard-library import of the public Kaluga police XLSX.

No network requests, geocoding, workbook execution or coordinate repair.
Usage: python tools/import-gibdd-kaluga.py --input source.xlsx --output facts.json
       --retrieved-at 2026-11-07T08:55:26Z
"""
import argparse
import collections
import hashlib
import io
import json
import re
import unicodedata
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

SOURCE_URL = "https://xn--80aebkobnwfcnsfk1e0h.xn--p1ai/upload/site40/report/publication/file/sayt_oktyabr.xlsx"
INDEX_URL = "https://xn--80aebkobnwfcnsfk1e0h.xn--p1ai/r/40"
REUSE_URL = INDEX_URL + "#copyright"
CURRENT_SOURCE_SHA256 = "a62b2858aecdbeb63e43445b556c9db9d6c628e674c9e96fb5a5a01074d16089"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
MAX_XLSX_BYTES = 8 * 1024 * 1024
MAX_UNPACKED_BYTES = 32 * 1024 * 1024
PAIR = re.compile(r"(?<![\d.])([+-]?\d{1,3}\.\d+)\s*[,; ]\s*([+-]?\d{1,3}\.\d+)(?![\d.])")
# Broad legal categories remain broad categories. They do not establish a bus
# lane, a camera model, an individual travel bearing, or front/rear capture.
CONTROL_PATTERNS = [
    ("speed", r"Превышение скорост[иь]?"),
    ("belt", r"Нарушение правил прим[еи]нения ремней безопасности или мотошлемов"),
    ("pedestrian", r"Непредоставление преимущества в движении пешеходам или иным участникам дорожного движения"),
    ("redlight", r"Проезд на запрещающий сигнал светофора"),
    ("stopline", r"Не\s*выполнение требования правил дорожного движения об остановке перед стоп-линией"),
    ("phone", r"(?:Нарушение правил пользования телефоном водителем транспортного средства|пользование телефоном во время движения)"),
    ("signs_marking", r"Несоблюдение требований, предписанных дорожными знаками или разметкой проезжей части дороги"),
    ("road_position", r"Нарушение правил расположения транспортного средства на проезжей части дороги, встречного разъезда или обгона"),
]


def clean(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value or "")).strip()


def parse_positions(raw):
    """All coordinate text must be consumed. Missing decimal points are errors."""
    result, residue = [], raw
    for match in PAIR.finditer(raw):
        lat, lon = float(match.group(1)), float(match.group(2))
        if not 53 <= lat <= 56 or not 33 <= lon <= 38:
            return [], "COORDINATE_OUTSIDE_REGION_BOUNDS"
        result.append({"lat": lat, "lon": lon,
                       "latDecimalPlaces": len(match.group(1).split(".")[1]),
                       "lonDecimalPlaces": len(match.group(2).split(".")[1]),
                       "raw": match.group(0)})
        residue = residue.replace(match.group(0), " ", 1)
    if not result or re.search(r"[^\s,;]", residue):
        return [], "COORDINATE_UNPARSEABLE_NO_INFERRED_DECIMAL"
    return result, None


def parse_controls(raw):
    controls, evidence, residue = [], [], raw
    for control, pattern in CONTROL_PATTERNS:
        matches = list(re.finditer(pattern, raw, re.IGNORECASE))
        if matches:
            controls.append(control)
            evidence.append({"control": control, "matchedText": matches[0].group(0)})
        residue = re.sub(pattern, "", residue, flags=re.IGNORECASE)
    residue = re.sub(r"(?:,\s*){2,}", ", ", residue).strip(" ,\t\r\n")
    return controls, evidence, residue or None


def worksheet_rows(data):
    if len(data) > MAX_XLSX_BYTES:
        raise ValueError("XLSX_SIZE")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > 100 or sum(m.file_size for m in members) > MAX_UNPACKED_BYTES:
            raise ValueError("XLSX_UNPACKED_SIZE")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("XLSX_DUPLICATE_ARCHIVE_MEMBER")
        sheets = [n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)]
        if len(sheets) != 1:
            raise ValueError("XLSX_EXPECTED_SINGLE_WORKSHEET")
        strings = []
        if "xl/sharedStrings.xml" in names:
            for item in ET.fromstring(archive.read("xl/sharedStrings.xml")):
                strings.append("".join(t.text or "" for t in item.findall(".//s:t", NS)))
        rows = []
        sheet = ET.fromstring(archive.read(sheets[0]))
        for row in sheet.findall("s:sheetData/s:row", NS):
            number = int(row.attrib["r"])
            fields = {}
            for cell in row.findall("s:c", NS):
                if cell.find("s:f", NS) is not None:
                    raise ValueError("XLSX_FORMULA_REQUIRES_REVIEW")
                column = re.sub(r"\d+$", "", cell.attrib["r"])
                value = cell.find("s:v", NS)
                text = value.text if value is not None else None
                if cell.get("t") == "s" and text is not None:
                    text = strings[int(text)]
                if cell.get("t") == "inlineStr":
                    text = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                if text is not None:
                    fields[column] = clean(text)
            rows.append({"row": number, "fields": fields})
        return sheets[0], rows


def stable_id(position, address, conditions, controls):
    identity = {"position": position, "address": clean(address),
                "conditions": clean(conditions), "controls": sorted(controls)}
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "gibdd:ru-klu:" + hashlib.sha256(encoded).hexdigest()[:16]


def validate_source_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("SOURCE_URL")
    url = urlsplit(value)
    host = (url.hostname or "").encode("idna").decode("ascii").lower()
    allowed = {"xn--80aebkobnwfcnsfk1e0h.xn--p1ai", "xn--90adear.xn--p1ai"}
    if url.scheme != "https" or host not in allowed or url.username is not None or url.password is not None or url.port or url.query or url.fragment:
        raise ValueError("SOURCE_URL")
    prefix = "/upload/site40/report/publication/file/"
    decoded = unquote(url.path)
    if not decoded.startswith(prefix):
        raise ValueError("SOURCE_URL_PATH")
    name = decoded[len(prefix):]
    if not 6 <= len(name) <= 160 or not re.fullmatch(r"[\w.() -]+\.xlsx", name, re.UNICODE) or ".." in name:
        raise ValueError("SOURCE_URL_FILENAME")
    # The legacy police domain redirects to the same canonical official site.
    return urlunsplit(("https", "xn--80aebkobnwfcnsfk1e0h.xn--p1ai", prefix + quote(name, safe="._-()"), "", ""))


def import_workbook(data, retrieved_at, publication_date="2026-10-01", last_modified=None, source_url=SOURCE_URL):
    source_url = validate_source_url(source_url)
    parsed_date = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
    if parsed_date.utcoffset() is None:
        raise ValueError("RETRIEVED_AT_MUST_HAVE_TIMEZONE")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", publication_date):
        raise ValueError("PUBLICATION_DATE_MUST_BE_YYYY_MM_DD")
    datetime.fromisoformat(publication_date)
    sheet, rows = worksheet_rows(data)
    records, mobile, rejected, source_rows, seen = [], [], [], [], set()
    section, header_checked = None, False
    source_sha = hashlib.sha256(data).hexdigest()
    raw_control_counts, imported_control_counts = collections.Counter(), collections.Counter()
    raw_violation_frequency, unmapped_frequency, mode_frequency = collections.Counter(), collections.Counter(), collections.Counter()
    multiple_rows = []
    for item in rows:
        values, row = item["fields"], item["row"]
        heading = values.get("A", "")
        if heading == "Стационарные и передвижные средства фиксации":
            section, header_checked = "stationary-or-portable", False
            continue
        if heading == "Мобильные средства фиксации":
            section, header_checked = "mobile-route", False
            continue
        if heading == "Адрес рубежа":
            if section != "stationary-or-portable" or values.get("B") != "Географические координаты" or values.get("C") != "Контролируемые условия и режимы движения" or values.get("D") != "Фиксируемые нарушения":
                raise ValueError("XLSX_FIXED_HEADER_REQUIRES_REVIEW")
            header_checked = True
            continue
        if heading.startswith("Маршрут движения"):
            if section != "mobile-route" or values.get("B") != "Контролируемые условия и режимы движения" or values.get("C") != "Виды выявленных нарушений правил дорожного движения":
                raise ValueError("XLSX_MOBILE_HEADER_REQUIRES_REVIEW")
            header_checked = True
            continue
        if not heading:
            continue
        if section is None or not header_checked:
            raise ValueError("XLSX_UNKNOWN_SECTION_OR_HEADER")
        if section == "mobile-route":
            polyline = []
            for lat, lon in re.findall(r"(?<![\d.])(\d{2}\.\d+)\s*[,;]\s*(\d{2}\.\d+)(?![\d.])", heading):
                if 53 <= float(lat) <= 56 and 33 <= float(lon) <= 38:
                    polyline.append({"lat": float(lat), "lon": float(lon)})
            mobile.append({"sourceRow": row, "trajectoryRaw": heading,
                           "operatingConditions": values.get("B", ""),
                           "rawControls": values.get("C", ""), "polyline": polyline,
                           "importAsFixedCamera": False})
            continue
        controls, evidence, unmapped = parse_controls(values.get("D", ""))
        raw_control_counts.update(controls)
        raw_violation_frequency.update([values.get("D", "")])
        mode_frequency.update([values.get("C", "")])
        if unmapped:
            unmapped_frequency.update([unmapped])
        coordinates, error = parse_positions(values.get("B", ""))
        source_rows.append({"sourceRow": row, "address": heading, "coordinatesRaw": values.get("B", ""),
                            "operatingConditions": values.get("C", ""), "rawControls": values.get("D", ""),
                            "controls": controls, "unmappedControls": unmapped})
        if error:
            rejected.append({"sourceRow": row, "address": heading, "coordinatesRaw": values.get("B", ""), "reason": error})
            continue
        if len(coordinates) > 1:
            multiple_rows.append(row)
        for index, coordinate in enumerate(coordinates):
            position = {"lat": coordinate["lat"], "lon": coordinate["lon"]}
            ident = stable_id(position, heading, values.get("C", ""), controls)
            if ident in seen:
                raise ValueError("DUPLICATE_OBSERVATION_ID_REQUIRES_REVIEW")
            seen.add(ident)
            imported_control_counts.update(controls)
            records.append({"id": ident, "position": position, "sourceRow": row,
                            "sourceCoordinateIndex": index, "address": heading,
                            "controls": controls, "rawControls": values.get("D", ""),
                            "controlEvidence": evidence, "unmappedControls": unmapped,
                            "operatingConditions": values.get("C", ""), "captureSide": "unknown",
                            "bearingDeg": None, "limitKmh": None, "hardwareModel": None,
                            "type": "redlight" if "redlight" in controls else "speed" if "speed" in controls else "camera",
                            "provenance": "Госавтоинспекция", "positionKind": "official-location",
                            "description": heading[:250], "sourceUrl": source_url,
                            "sourceSheet": sheet, "sourcePublishedAt": publication_date,
                            "coordinatePrecision": {"latDecimalPlaces": coordinate["latDecimalPlaces"], "lonDecimalPlaces": coordinate["lonDecimalPlaces"]},
                            "coordinatesRaw": values.get("B", "")})
    if not source_rows or not records or not mobile:
        raise ValueError("XLSX_EXPECTED_FIXED_AND_MOBILE_SECTIONS")
    records.sort(key=lambda r: r["id"])
    return {"schema": 1, "source": "gibdd-official", "region": "RU-KLU",
            "publishedAt": publication_date, "retrievedAt": retrieved_at,
            "sourceLastModified": last_modified, "sourceUrl": source_url,
            "sourceIndexUrl": INDEX_URL, "sourceSha256": source_sha,
            "reuse": {"statementUrl": REUSE_URL, "attributionRequired": True,
                      "statement": "Сайт МВД разрешает воспроизведение материалов с обязательной ссылкой на первоисточник; это не обозначение лицензии ODbL или GPL."},
            "records": records,
            "audit": {"fixedRows": len(source_rows), "acceptedRows": len(source_rows) - len(rejected),
                      "coordinatePositions": len(records), "uniqueExactPositions": len({(r["position"]["lat"], r["position"]["lon"]) for r in records}),
                      "multipleCoordinateRows": multiple_rows, "rejected": rejected,
                      "mobileRoutes": len(mobile), "mobileRoutePointMentions": sum(len(r["polyline"]) for r in mobile),
                      "mobileRouteRecords": mobile, "sourceRows": source_rows,
                      "rawRowControlCounts": dict(sorted(raw_control_counts.items())),
                      "importedPositionControlCounts": dict(sorted(imported_control_counts.items())),
                      "rawViolationFrequency": dict(sorted(raw_violation_frequency.items())),
                      "unmappedViolationFrequency": dict(sorted(unmapped_frequency.items())),
                      "operatingConditionsFrequency": dict(sorted(mode_frequency.items())),
                      "numericLimitsProvided": 0, "captureSidesProvided": 0, "bearingDegreesProvided": 0,
                      "coverage": "Перечень опубликованных рубежей на указанную дату; не доказательство полноты, работоспособности, числа физических камер или точного положения каждой опоры."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--retrieved-at", required=True)
    parser.add_argument("--published-at", help="Date stated by the official index, never inferred from a filename")
    parser.add_argument("--source-url", default=SOURCE_URL)
    parser.add_argument("--last-modified", help="Observed HTTP Last-Modified, if provided by the source")
    args = parser.parse_args()
    data = args.input.read_bytes()
    # Only the exact archived snapshot has known defaults; a future workbook
    # must carry the actual date observed on its official publication page.
    current = hashlib.sha256(data).hexdigest() == CURRENT_SOURCE_SHA256 and validate_source_url(args.source_url) == SOURCE_URL
    if not args.published_at and not current:
        parser.error("--published-at is required for a new source snapshot")
    published = args.published_at or "2026-10-01"
    modified = args.last_modified or ("2026-10-07T07:56:09Z" if current else None)
    facts = import_workbook(data, args.retrieved_at, published, modified, args.source_url)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(facts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": args.output.name, "records": len(facts["records"]),
                      "fixedRows": facts["audit"]["fixedRows"], "rejected": len(facts["audit"]["rejected"]),
                      "mobileRoutesExcluded": facts["audit"]["mobileRoutes"], "sha256": facts["sourceSha256"]}))


if __name__ == "__main__":
    main()
