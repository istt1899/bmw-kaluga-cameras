# SPDX-License-Identifier: GPL-3.0-or-later
"""Manual host-only source check; writes candidates to a NEW/EMPTY directory.

Downloads only the approved police index/workbook and fixed OSM mirror URLs.
It never publishes, updates a runtime manifest/database, or sends vehicle GPS.
An MD5 change in a regional PBF is not proof that camera facts have changed.
"""
import argparse
import hashlib
import json
import re
import ssl
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent.parent
POLICE_HOST = "xn--80aebkobnwfcnsfk1e0h.xn--p1ai"
INDEX_URL = "https://" + POLICE_HOST + "/r/40"
FILE_PREFIX = "/upload/site40/report/publication/file/"
OSM_ROOT = "https://download.openstreetmap.fr/extracts/russia/central_federal_district/"
PBF_URL = OSM_ROOT + "kaluga_oblast.osm.pbf"
STATE_URL = OSM_ROOT + "kaluga_oblast.state.txt"
MD5_URL = PBF_URL + ".md5"
MAX_XLSX = 8 * 1024 * 1024
MAX_PBF = 128 * 1024 * 1024


class SourceError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def allowed_url(value, kind):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f]", value):
        raise SourceError("SOURCE_URL_INVALID")
    try:
        part = urlsplit(value)
        host = (part.hostname or "").encode("idna").decode("ascii").lower()
        if part.scheme != "https" or part.username or part.password or part.port or part.query or part.fragment:
            raise SourceError("SOURCE_URL_FORBIDDEN")
    except (ValueError, UnicodeError):
        raise SourceError("SOURCE_URL_INVALID") from None
    if kind == "official-index":
        if host != POLICE_HOST or part.path.rstrip("/") != "/r/40":
            raise SourceError("SOURCE_URL_FORBIDDEN")
        return INDEX_URL
    if kind == "official-workbook":
        decoded = unquote(part.path)
        name = decoded[len(FILE_PREFIX):] if decoded.startswith(FILE_PREFIX) else ""
        if host != POLICE_HOST or not 6 <= len(name) <= 160 or ".." in name or not re.fullmatch(r"[\w.() -]+\.xlsx", name, re.UNICODE):
            raise SourceError("SOURCE_URL_FORBIDDEN")
        return urlunsplit(("https", POLICE_HOST, FILE_PREFIX + quote(name, safe="._-()"), "", ""))
    known = {"osm-state": STATE_URL, "osm-md5": MD5_URL, "osm-pbf": PBF_URL}
    canonical = urlunsplit(("https", host, part.path, "", ""))
    if canonical != known.get(kind):
        raise SourceError("SOURCE_URL_FORBIDDEN")
    return canonical


class StrictRedirects(HTTPRedirectHandler):
    def __init__(self, kind):
        self.kind, self.count = kind, 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.count += 1
        if self.count > 3:
            raise SourceError("SOURCE_REDIRECT_LIMIT")
        target = allowed_url(urljoin(req.full_url, newurl), self.kind)
        # No Authorization, cookies or caller-controlled headers are copied.
        return Request(target, headers={"User-Agent": "Waze-Strelka-Manual-Source-Check", "Accept": "*/*"})


class SourceFetcher:
    def __init__(self, opener_factory=None):
        # A test-only in-process seam, not an alternate URL/transport CLI.
        self.opener_factory = opener_factory

    def fetch(self, value, kind, limit, destination=None):
        value = allowed_url(value, kind)
        opener = self.opener_factory(kind) if self.opener_factory else build_opener(
            StrictRedirects(kind), HTTPSHandler(context=ssl.create_default_context()))
        request = Request(value, headers={"User-Agent": "Waze-Strelka-Manual-Source-Check", "Accept": "*/*"})
        started, size, chunks = time.monotonic(), 0, []
        sha, md5, output = hashlib.sha256(), hashlib.md5(), None
        try:
            with opener.open(request, timeout=20) as response:
                final_url = allowed_url(response.geturl(), kind)
                if response.status != 200:
                    raise SourceError("SOURCE_HTTP_" + str(response.status))
                headers = response.headers
                if headers.get("Content-Encoding", "identity").lower() not in ("identity", ""):
                    raise SourceError("SOURCE_CONTENT_ENCODING")
                length = headers.get("Content-Length")
                if length is not None and (not re.fullmatch(r"\d+", length) or int(length) > limit):
                    raise SourceError("SOURCE_SIZE")
                if destination is not None:
                    output = Path(destination).open("xb")
                while True:
                    if time.monotonic() - started > 120:
                        raise SourceError("SOURCE_TOTAL_TIMEOUT")
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        raise SourceError("SOURCE_SIZE")
                    sha.update(chunk)
                    md5.update(chunk)
                    if output:
                        output.write(chunk)
                    else:
                        chunks.append(chunk)
                if length is not None and int(length) != size:
                    raise SourceError("SOURCE_LENGTH_MISMATCH")
                result = {"url": value, "finalUrl": final_url, "size": size, "sha256": sha.hexdigest(), "md5": md5.hexdigest(),
                          "lastModified": str(headers.get("Last-Modified", ""))[:256] or None}
                if destination is None:
                    result["body"] = b"".join(chunks)
                return result
        except Exception:
            if output:
                output.close()
                # Only this call's newly created candidate is removed.
                Path(destination).unlink(missing_ok=True)
            raise
        finally:
            if output and not output.closed:
                output.close()


class WorkbookLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = set()

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a":
            return
        for key, value in attrs:
            if key.lower() != "href" or not value:
                continue
            try:
                self.links.add(allowed_url(urljoin(INDEX_URL, value), "official-workbook"))
            except SourceError:
                pass


def workbook_url(html):
    parser = WorkbookLinks()
    parser.feed(html.decode("utf-8", "strict"))
    if not parser.links:
        raise SourceError("OFFICIAL_WORKBOOK_LINK_MISSING")
    if len(parser.links) != 1:
        raise SourceError("OFFICIAL_WORKBOOK_LINK_AMBIGUOUS")
    return next(iter(parser.links))


def parse_md5(data):
    match = re.fullmatch(r"([a-fA-F0-9]{32})\s+\*?kaluga_oblast\.osm\.pbf\s*", data.decode("ascii"))
    if not match:
        raise SourceError("OSM_MD5_FORMAT")
    return match.group(1).lower()


def parse_state(data):
    fields = {}
    for line in data.decode("ascii").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or key in fields:
            raise SourceError("OSM_STATE_FORMAT")
        fields[key] = value.replace("\\:", ":")
    if not re.fullmatch(r"\d+", fields.get("sequenceNumber", "")):
        raise SourceError("OSM_STATE_FORMAT")
    stamp = fields.get("timestamp", "")
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if not stamp.endswith("Z") or parsed.utcoffset() is None:
            raise ValueError()
    except ValueError:
        raise SourceError("OSM_STATE_FORMAT") from None
    return {"sequenceNumber": int(fields["sequenceNumber"]), "timestamp": stamp}


def read_json(path, max_bytes=8 * 1024 * 1024):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > max_bytes:
        raise SourceError("BASELINE_FILE_INVALID")
    return json.loads(path.read_text(encoding="utf-8"))


def public_meta(value):
    return {key: item for key, item in value.items() if key != "body"}


def run_checked(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=240, check=False)
    if result.returncode:
        # No host paths, inherited environment, credentials or full traceback
        # are copied into the public candidate report.
        match = re.findall(r"(?:ValueError|SourceError):\s*([A-Z][A-Z0-9_]+)", result.stderr)
        raise SourceError(match[-1] if match else "SOURCE_NORMALIZER_FAILED")


def facts_digest(snapshot):
    if snapshot.get("schema") != 1 or snapshot.get("kind") != "osm-camera-source":
        return None
    volatile = {"osmVersion", "osmTimestamp", "osmChangeset", "lastSeenInSnapshot", "generatedAt"}
    def stable(value):
        if isinstance(value, list):
            return [stable(item) for item in value]
        if isinstance(value, dict):
            return {key: stable(item) for key, item in value.items() if key not in volatile}
        return value
    selected = {key: stable(snapshot.get(key, [])) for key in ("records", "reviewCandidates", "inactiveRecords", "excluded", "enforcementRelations")}
    return hashlib.sha256(json.dumps(selected, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def check_official(args, out, fetcher, runner, baseline, now):
    index = fetcher.fetch(INDEX_URL, "official-index", 2 * 1024 * 1024)
    selected = workbook_url(index["body"])
    workbook = fetcher.fetch(selected, "official-workbook", MAX_XLSX, out / "official-source.xlsx")
    unchanged = workbook["sha256"] == baseline["sourceSha256"]
    report = {"status": "unchanged" if unchanged else "source-changed", "index": public_meta(index), "workbook": public_meta(workbook),
              "baselineSha256": baseline["sourceSha256"], "rawCandidate": "official-source.xlsx", "reviewRequired": True}
    published = args.published_at or (baseline.get("publishedAt") if unchanged else None)
    if not published:
        report.update(status="review-required", reason="OFFICIAL_PUBLICATION_DATE_REQUIRED")
        return report
    try:
        date.fromisoformat(published)
    except ValueError:
        raise SourceError("OFFICIAL_PUBLICATION_DATE_INVALID") from None
    command = [sys.executable, str(ROOT / "tools/import-gibdd-kaluga.py"), "--input", str(out / "official-source.xlsx"),
               "--output", str(out / "official-normalized.json"), "--retrieved-at", now, "--published-at", published,
               "--source-url", workbook["finalUrl"]]
    if workbook["lastModified"]:
        try:
            parsed_modified = parsedate_to_datetime(workbook["lastModified"])
            if parsed_modified.utcoffset() is None:
                raise ValueError()
            modified = parsed_modified.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, TypeError, OverflowError):
            raise SourceError("OFFICIAL_LAST_MODIFIED_INVALID") from None
        command += ["--last-modified", modified]
    runner(command)
    normalized = read_json(out / "official-normalized.json")
    if normalized.get("schema") != 1 or normalized.get("source") != "gibdd-official" or normalized.get("region") != "RU-KLU" or normalized.get("sourceSha256") != workbook["sha256"]:
        raise SourceError("OFFICIAL_NORMALIZED_SCHEMA")
    report.update(normalizedCandidate="official-normalized.json", publishedAt=published, records=len(normalized["records"]), audit=normalized.get("audit", {}))
    return report


def check_osm(args, out, fetcher, runner, baseline):
    before_state = parse_state(fetcher.fetch(STATE_URL, "osm-state", 16384)["body"])
    before_md5 = parse_md5(fetcher.fetch(MD5_URL, "osm-md5", 4096)["body"])
    baseline_md5 = baseline.get("inputMd5") or baseline.get("pbfMd5")
    report = {"status": "unchanged" if before_md5 == baseline_md5 else "source-archive-changed", "state": before_state,
              "publishedMd5": before_md5, "baselineMd5": baseline_md5, "archiveChanged": before_md5 != baseline_md5,
              "cameraFactsChanged": None, "cameraFactsStatus": "not-compared", "downloadedPbf": False,
              "note": "A whole-region PBF hash change alone does not establish changed camera facts.", "reviewRequired": True}
    if not args.download_osm:
        return report
    pbf = fetcher.fetch(PBF_URL, "osm-pbf", MAX_PBF, out / "osm-source.pbf")
    after_state = parse_state(fetcher.fetch(STATE_URL, "osm-state", 16384)["body"])
    after_md5 = parse_md5(fetcher.fetch(MD5_URL, "osm-md5", 4096)["body"])
    if before_state != after_state or before_md5 != after_md5:
        raise SourceError("OSM_SOURCE_CHANGED_DURING_DOWNLOAD")
    if pbf["md5"] != before_md5:
        raise SourceError("OSM_PBF_MD5_MISMATCH")
    runner([args.node, str(ROOT / "tools/build-osm-camera-snapshot.mjs"), "--pbf", str(out / "osm-source.pbf"), "--output-dir", str(out / "osm-candidate")])
    normalized = read_json(out / "osm-candidate/osm-camera-source.json", 32 * 1024 * 1024)
    if normalized.get("schema") != 1 or normalized.get("kind") != "osm-camera-source" or normalized.get("region") != "RU-KLU" or normalized.get("inputMd5") != before_md5:
        raise SourceError("OSM_NORMALIZED_SCHEMA")
    old_facts, new_facts = facts_digest(baseline), facts_digest(normalized)
    report.update(downloadedPbf=True, archive=public_meta(pbf), normalizedCandidate="osm-candidate/osm-camera-source.json", counts=normalized.get("counts", {}))
    if old_facts and new_facts:
        report.update(cameraFactsChanged=old_facts != new_facts, cameraFactsStatus="changed" if old_facts != new_facts else "unchanged")
    else:
        report["note"] += " Legacy baseline does not support a like-for-like normalized fact comparison."
    return report


def run_checks(args, fetcher=None, runner=None):
    out = Path(args.output_dir).resolve()
    if Path(args.output_dir).is_symlink() or out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise SourceError("OUTPUT_DIRECTORY_MUST_BE_NEW_OR_EMPTY")
    out.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    report = {"schema": 1, "region": "RU-KLU", "checkedAt": now, "publicationEligible": False, "reviewRequired": True,
              "runtimeMutation": False, "vehicleDataUploaded": False, "errors": []}
    fetcher, runner = fetcher or SourceFetcher(), runner or run_checked
    try:
        registry = read_json(ROOT / "data/source-registry.json", 256 * 1024)
        sources = {source["id"]: source for source in registry.get("sources", [])}
        if registry.get("schema") != 1 or registry.get("region") != "RU-KLU" or any(sources.get(name, {}).get("redistribution") != "approved" for name in ("gibdd-official", "osm")):
            raise SourceError("SOURCE_NOT_APPROVED")
        report["sourcePolicy"] = {"registrySha256": hashlib.sha256((ROOT / "data/source-registry.json").read_bytes()).hexdigest(), "approvedSourceIds": ["gibdd-official", "osm"]}
        official_baseline = read_json(args.official_baseline)
        osm_baseline = read_json(args.osm_baseline, 32 * 1024 * 1024)
        if official_baseline.get("source") != "gibdd-official" or official_baseline.get("region") != "RU-KLU" or not re.fullmatch(r"[a-f0-9]{64}", official_baseline.get("sourceSha256", "")):
            raise SourceError("OFFICIAL_BASELINE_SCHEMA")
        if osm_baseline.get("source") != "OpenStreetMap" or osm_baseline.get("region") != "RU-KLU" or not re.fullmatch(r"[a-f0-9]{32}", osm_baseline.get("inputMd5") or osm_baseline.get("pbfMd5") or ""):
            raise SourceError("OSM_BASELINE_SCHEMA")
        for name, operation in (("official", lambda: check_official(args, out, fetcher, runner, official_baseline, now)),
                                ("osm", lambda: check_osm(args, out, fetcher, runner, osm_baseline))):
            try:
                report[name] = operation()
            except Exception as error:
                code = error.code if isinstance(error, SourceError) else "SOURCE_CHECK_FAILED"
                report[name] = {"status": "error", "errorCode": code, "reviewRequired": True}
                candidate_name = "official-source.xlsx" if name == "official" else "osm-source.pbf"
                candidate = out / candidate_name
                if candidate.is_file() and not candidate.is_symlink():
                    # A failed normalizer leaves the downloaded original for
                    # review. Do not pretend an unparsed candidate is eligible.
                    digest = hashlib.sha256()
                    with candidate.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(65536), b""):
                            digest.update(chunk)
                    report[name].update(rawCandidate=candidate_name, candidateSha256=digest.hexdigest(), candidateBytes=candidate.stat().st_size)
                report["errors"].append({"source": name, "code": code})
    except Exception as error:
        report["errors"].append({"source": "policy-or-baseline", "code": error.code if isinstance(error, SourceError) else "SOURCE_CHECK_FAILED"})
    report["status"] = "error" if report["errors"] else "review-required" if any(report.get(name, {}).get("status") == "review-required" for name in ("official", "osm")) else "checked"
    (out / "source-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--official-baseline", type=Path, default=ROOT / "data/references/gibdd-kaluga-2026-10-01.json")
    parser.add_argument("--osm-baseline", type=Path, default=ROOT / "data/references/osm-camera-source-2026-11-07.json")
    parser.add_argument("--published-at", help="Verified official publication date for a changed workbook, YYYY-MM-DD")
    parser.add_argument("--download-osm", choices=("true", "false"), default="false")
    parser.add_argument("--node", default="node", help="Local Node executable used only with --download-osm true")
    args = parser.parse_args()
    args.download_osm = args.download_osm == "true"
    try:
        report = run_checks(args)
    except SourceError as error:
        parser.exit(1, error.code + "\n")
    print(json.dumps({"status": report["status"], "official": report.get("official", {}).get("status"), "osm": report.get("osm", {}).get("status"), "publicationEligible": False}))
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
