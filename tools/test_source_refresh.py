# SPDX-License-Identifier: GPL-3.0-or-later
"""Offline transport, review-gate and hash-race tests; no network or npm needed."""
import copy
import hashlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.request import Request

sys.dont_write_bytecode = True


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = load("camera_source_check", "check-camera-source-updates.py")
FIXTURE = load("police_test_fixture", "test_gibdd_import.py")
XLSX_URL = "https://" + CHECK.POLICE_HOST + CHECK.FILE_PREFIX + "candidate.xlsx"
STATE = b"sequenceNumber=7361722\ntimestamp=2026-11-07T00\\:07\\:21Z\n"
PBF = b"offline-parser-fixture-not-a-real-pbf"
MD5 = hashlib.md5(PBF).hexdigest()


class Response(io.BytesIO):
    def __init__(self, body, url, headers=None, status=200):
        super().__init__(body)
        self.url, self.status = url, status
        self.headers = {"Content-Length": str(len(body)), **(headers or {})}

    def geturl(self):
        return self.url


class FixtureTransport:
    """Routes exact requests through real SourceFetcher boundary checks."""
    def __init__(self, routes):
        self.routes, self.requests = routes, []

    def factory(self, kind):
        transport = self
        class Opener:
            def open(self, request, timeout):
                transport.requests.append((request.full_url, kind, timeout))
                values = transport.routes.get(request.full_url)
                if not values:
                    raise AssertionError("Unexpected network request: " + request.full_url)
                value = values.pop(0)
                if isinstance(value, Exception):
                    raise value
                if isinstance(value, tuple):
                    body, headers, *final_url = value
                    return Response(body, final_url[0] if final_url else request.full_url, headers)
                return Response(value, request.full_url)
        return Opener()

    def fetcher(self):
        return CHECK.SourceFetcher(self.factory)


class SourceTransportTests(unittest.TestCase):
    def assertCode(self, expected, operation):
        with self.assertRaises(CHECK.SourceError) as raised:
            operation()
        self.assertEqual(raised.exception.code, expected)

    def test_only_exact_public_https_source_roles_are_allowed(self):
        self.assertEqual(CHECK.allowed_url(CHECK.INDEX_URL + "/", "official-index"), CHECK.INDEX_URL)
        self.assertEqual(CHECK.allowed_url("https://госавтоинспекция.рф" + CHECK.FILE_PREFIX + "Пример.xlsx", "official-workbook"),
                         "https://" + CHECK.POLICE_HOST + CHECK.FILE_PREFIX + "%D0%9F%D1%80%D0%B8%D0%BC%D0%B5%D1%80.xlsx")
        bad = ["http://" + CHECK.POLICE_HOST + "/r/40", "https://user:secret@" + CHECK.POLICE_HOST + "/r/40",
               CHECK.INDEX_URL + "?token=secret", CHECK.INDEX_URL + "#fragment", CHECK.INDEX_URL.replace("/r/40", ":443/r/40"),
               "https://example.org/r/40", CHECK.INDEX_URL + "\n", "file:///tmp/source.xlsx"]
        for url in bad:
            with self.subTest(url=url):
                with self.assertRaises(CHECK.SourceError):
                    CHECK.allowed_url(url, "official-index")
        for path in ["../secret.xlsx", "%2e%2e/secret.xlsx", "%252e%252e.xlsx", "nested/test.xlsx", "a.xls", "a.xlsx?key=x"]:
            with self.subTest(path=path), self.assertRaises(CHECK.SourceError):
                CHECK.allowed_url("https://" + CHECK.POLICE_HOST + CHECK.FILE_PREFIX + path, "official-workbook")
        for kind in ["osm-pbf", "osm-md5", "osm-state"]:
            with self.subTest(kind=kind), self.assertRaises(CHECK.SourceError):
                CHECK.allowed_url("https://example.org/kaluga_oblast.osm.pbf", kind)

    def test_redirects_revalidate_target_and_never_forward_credentials(self):
        redirect = CHECK.StrictRedirects("official-workbook")
        request = Request(XLSX_URL, headers={"Authorization": "secret", "Cookie": "secret"})
        next_request = redirect.redirect_request(request, None, 302, "Found", {}, XLSX_URL)
        self.assertIsNone(next_request.get_header("Authorization"))
        self.assertIsNone(next_request.get_header("Cookie"))
        self.assertCode("SOURCE_URL_FORBIDDEN", lambda: redirect.redirect_request(request, None, 302, "Found", {}, "https://example.org/payload.xlsx"))
        repeated = CHECK.StrictRedirects("official-workbook")
        for _ in range(3):
            repeated.redirect_request(request, None, 302, "Found", {}, XLSX_URL)
        self.assertCode("SOURCE_REDIRECT_LIMIT", lambda: repeated.redirect_request(request, None, 302, "Found", {}, XLSX_URL))
        transport = FixtureTransport({XLSX_URL: [(b"ok", {}, "https://example.org/final.xlsx")]})
        self.assertCode("SOURCE_URL_FORBIDDEN", lambda: transport.fetcher().fetch(XLSX_URL, "official-workbook", 8))

    def test_size_encoding_and_truncated_transfer_fail_closed(self):
        cases = [((b"ok", {"Content-Length": "9"}), "SOURCE_SIZE"),
                 ((b"012345678", {"Content-Length": ""}), "SOURCE_SIZE"),
                 ((b"ok", {"Content-Length": "3"}), "SOURCE_LENGTH_MISMATCH"),
                 ((b"ok", {"Content-Encoding": "gzip"}), "SOURCE_CONTENT_ENCODING")]
        for response, error in cases:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as folder:
                transport = FixtureTransport({XLSX_URL: [response]})
                target = Path(folder) / "new.xlsx"
                self.assertCode(error, lambda: transport.fetcher().fetch(XLSX_URL, "official-workbook", 8, target))
                self.assertFalse(target.exists())
        # No Content-Length is normal for chunked HTTPS; enforce actual bytes.
        transport = FixtureTransport({XLSX_URL: [b"012345678"]})
        original_factory = transport.factory
        def no_length_factory(kind):
            opener = original_factory(kind)
            old_open = opener.open
            def open_without_length(request, timeout):
                response = old_open(request, timeout)
                response.headers.pop("Content-Length")
                return response
            opener.open = open_without_length
            return opener
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "new.xlsx"
            self.assertCode("SOURCE_SIZE", lambda: CHECK.SourceFetcher(no_length_factory).fetch(XLSX_URL, "official-workbook", 8, target))
            self.assertFalse(target.exists())

    def test_success_is_streamed_and_never_overwrites_an_existing_file(self):
        transport = FixtureTransport({XLSX_URL: [b"abc", b"other"]})
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "source.xlsx"
            result = transport.fetcher().fetch(XLSX_URL, "official-workbook", 8, target)
            self.assertEqual(result["sha256"], hashlib.sha256(b"abc").hexdigest())
            self.assertNotIn("body", result)
            with self.assertRaises(FileExistsError):
                transport.fetcher().fetch(XLSX_URL, "official-workbook", 8, target)
            self.assertEqual(target.read_bytes(), b"abc")

    def test_unique_workbook_link_required_and_unapproved_links_ignored(self):
        link = '<a href="' + XLSX_URL + '">Download</a>'
        self.assertEqual(CHECK.workbook_url((link + link + '<a href="https://example.org/other.xlsx">x</a>').encode()), XLSX_URL)
        self.assertCode("OFFICIAL_WORKBOOK_LINK_MISSING", lambda: CHECK.workbook_url(b"<a href='/file.xls'>x</a>"))
        self.assertCode("OFFICIAL_WORKBOOK_LINK_AMBIGUOUS", lambda: CHECK.workbook_url((link + link.replace("candidate.xlsx", "second.xlsx")).encode()))

    def test_osm_sidecars_are_strict_and_parse_escaped_utc(self):
        self.assertEqual(CHECK.parse_md5((MD5 + "  kaluga_oblast.osm.pbf\n").encode()), MD5)
        self.assertEqual(CHECK.parse_state(STATE)["timestamp"], "2026-11-07T00:07:21Z")
        for body in [b"unknown", (MD5 + " wrong.pbf").encode()]:
            self.assertCode("OSM_MD5_FORMAT", lambda: CHECK.parse_md5(body))
        for body in [b"timestamp=2026-11-07T00:00:00Z\n", STATE + b"sequenceNumber=9\n", STATE.replace(b"07T00", b"40T00")]:
            self.assertCode("OSM_STATE_FORMAT", lambda: CHECK.parse_state(body))


class SourceCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.workbook = FIXTURE.workbook()
        self.official = {"schema": 1, "source": "gibdd-official", "region": "RU-KLU", "publishedAt": "2026-10-01",
                         "sourceSha256": hashlib.sha256(self.workbook).hexdigest()}
        self.osm = {"schema": 1, "kind": "osm-camera-source", "source": "OpenStreetMap", "region": "RU-KLU", "inputMd5": MD5,
                    "records": [{"id": "osm:node:1", "controls": ["speed"], "limitKmh": None, "osmTimestamp": "2026-10-01", "lastSeenInSnapshot": "old"}],
                    "reviewCandidates": [], "inactiveRecords": [], "excluded": [], "enforcementRelations": []}
        self.args = SimpleNamespace(output_dir=self.folder / "candidate", official_baseline=self.folder / "official.json",
                                    osm_baseline=self.folder / "osm.json", published_at=None, download_osm=False, node="test-node")
        self.baselines()

    def baselines(self):
        self.args.official_baseline.write_text(json.dumps(self.official), encoding="utf-8")
        self.args.osm_baseline.write_text(json.dumps(self.osm), encoding="utf-8")

    def transport(self, workbook=None, md5_after=None, state_after=None):
        return FixtureTransport({CHECK.INDEX_URL: [('<a href="' + XLSX_URL + '">source</a>').encode()],
                                 XLSX_URL: [(workbook if workbook is not None else self.workbook, {"Last-Modified": "Wed, 07 Oct 2026 07:56:09 GMT"})],
                                 CHECK.STATE_URL: [STATE, state_after if state_after is not None else STATE],
                                 CHECK.MD5_URL: [(MD5 + "  kaluga_oblast.osm.pbf\n").encode(), ((md5_after or MD5) + "  kaluga_oblast.osm.pbf\n").encode()],
                                 CHECK.PBF_URL: [PBF]})

    def runner(self, command, candidate=None):
        if command[0] == sys.executable:
            CHECK.run_checked(command)  # The actual importer parses synthetic XLSX.
            return
        self.assertEqual(command[0], "test-node")
        output = Path(command[command.index("--output-dir") + 1])
        output.mkdir()
        normalized = copy.deepcopy(candidate or self.osm)
        normalized["generatedAt"] = "new"
        normalized["records"][0]["lastSeenInSnapshot"] = "new"
        normalized["records"][0]["osmTimestamp"] = "new"
        (output / "osm-camera-source.json").write_text(json.dumps(normalized), encoding="utf-8")

    def run_checks(self, transport=None, runner=None):
        return CHECK.run_checks(self.args, (transport or self.transport()).fetcher(), runner or self.runner)

    def test_unchanged_official_normalized_real_importer_default_never_fetches_pbf(self):
        original_official, original_osm = self.args.official_baseline.read_bytes(), self.args.osm_baseline.read_bytes()
        transport = self.transport()
        report = self.run_checks(transport)
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["official"]["status"], "unchanged")
        self.assertEqual(report["official"]["records"], 3)
        self.assertEqual(report["official"]["audit"]["mobileRoutes"], 1)
        self.assertEqual(report["osm"]["status"], "unchanged")
        self.assertFalse(report["osm"]["downloadedPbf"])
        self.assertFalse(report["publicationEligible"])
        self.assertTrue(report["reviewRequired"])
        self.assertNotIn(CHECK.PBF_URL, [value[0] for value in transport.requests])
        self.assertEqual(self.args.official_baseline.read_bytes(), original_official)
        self.assertEqual(self.args.osm_baseline.read_bytes(), original_osm)
        candidate = json.loads((self.args.output_dir / "official-normalized.json").read_text(encoding="utf-8"))
        self.assertEqual(candidate["sourceUrl"], XLSX_URL)
        self.assertEqual(candidate["sourceLastModified"], "2026-10-07T07:56:09Z")

    def test_changed_workbook_requires_verified_publication_date_and_keeps_raw(self):
        new_workbook = FIXTURE.workbook(shared=True)
        report = self.run_checks(self.transport(workbook=new_workbook))
        self.assertEqual(report["official"]["status"], "review-required")
        self.assertEqual(report["official"]["reason"], "OFFICIAL_PUBLICATION_DATE_REQUIRED")
        self.assertEqual((self.args.output_dir / "official-source.xlsx").read_bytes(), new_workbook)
        self.assertFalse((self.args.output_dir / "official-normalized.json").exists())
        self.assertFalse(report["publicationEligible"])

    def test_changed_workbook_with_verified_date_normalizes_without_rewriting_baseline(self):
        self.args.published_at = "2026-11-01"
        report = self.run_checks(self.transport(workbook=FIXTURE.workbook(shared=True)))
        self.assertEqual(report["official"]["status"], "source-changed")
        self.assertEqual(report["official"]["publishedAt"], "2026-11-01")
        self.assertEqual(json.loads(self.args.official_baseline.read_text())["publishedAt"], "2026-10-01")

    def test_unknown_schema_is_error_not_empty_success_and_raw_is_auditable(self):
        self.args.published_at = "2026-11-01"
        report = self.run_checks(self.transport(workbook=b"not an xlsx"))
        self.assertEqual(report["official"]["status"], "error")
        self.assertEqual(report["status"], "error")
        self.assertEqual(report["official"]["candidateSha256"], hashlib.sha256(b"not an xlsx").hexdigest())
        self.assertTrue((self.args.output_dir / "official-source.xlsx").exists())
        self.assertEqual(report["osm"]["status"], "unchanged")

    def test_nonempty_output_directory_is_never_reused(self):
        self.args.output_dir.mkdir()
        (self.args.output_dir / "existing").write_text("preserve")
        with self.assertRaisesRegex(CHECK.SourceError, "OUTPUT_DIRECTORY_MUST_BE_NEW_OR_EMPTY"):
            self.run_checks()
        self.assertEqual((self.args.output_dir / "existing").read_text(), "preserve")

    def test_license_gate_runs_before_any_fetch(self):
        actual_read_json = CHECK.read_json
        def disapproved(path, *args):
            result = actual_read_json(path, *args)
            if Path(path).name == "source-registry.json":
                result["sources"] = [{"id": "gibdd-official", "redistribution": "not-established"}, {"id": "osm", "redistribution": "approved"}]
            return result
        transport = self.transport()
        with patch.object(CHECK, "read_json", side_effect=disapproved):
            report = self.run_checks(transport)
        self.assertEqual(report["errors"], [{"source": "policy-or-baseline", "code": "SOURCE_NOT_APPROVED"}])
        self.assertEqual(transport.requests, [])

    def test_osm_archive_change_alone_does_not_claim_camera_changes(self):
        self.osm["inputMd5"] = "0" * 32
        self.baselines()
        report = self.run_checks()
        self.assertEqual(report["osm"]["status"], "source-archive-changed")
        self.assertIsNone(report["osm"]["cameraFactsChanged"])
        self.assertEqual(report["osm"]["cameraFactsStatus"], "not-compared")

    def test_optional_download_compares_canonical_camera_facts_not_source_metadata(self):
        self.args.download_osm = True
        self.osm["inputMd5"] = "0" * 32
        self.baselines()
        candidate = copy.deepcopy(self.osm)
        candidate["inputMd5"] = MD5
        report = self.run_checks(runner=lambda command: self.runner(command, candidate))
        self.assertEqual(report["errors"], [])
        self.assertTrue(report["osm"]["archiveChanged"])
        self.assertTrue(report["osm"]["downloadedPbf"])
        self.assertFalse(report["osm"]["cameraFactsChanged"])
        self.assertEqual(report["osm"]["cameraFactsStatus"], "unchanged")

    def test_optional_download_detects_changed_camera_fact(self):
        self.args.download_osm = True
        candidate = copy.deepcopy(self.osm)
        candidate["records"][0]["limitKmh"] = 60
        report = self.run_checks(runner=lambda command: self.runner(command, candidate))
        self.assertTrue(report["osm"]["cameraFactsChanged"])

    def test_changing_source_sidecars_and_bad_pbf_hash_are_rejected_before_extraction(self):
        self.args.download_osm = True
        calls = []
        runner = lambda command: self.runner(command) if command[0] == sys.executable else calls.append(command)
        report = self.run_checks(self.transport(md5_after="0" * 32), runner)
        self.assertEqual(report["osm"]["errorCode"], "OSM_SOURCE_CHANGED_DURING_DOWNLOAD")
        self.assertEqual(calls, [])
        self.args.output_dir = self.folder / "second-candidate"
        bad_hash = self.transport()
        bad_hash.routes[CHECK.PBF_URL] = [b"wrong-content"]
        report = self.run_checks(bad_hash, runner)
        self.assertEqual(report["osm"]["errorCode"], "OSM_PBF_MD5_MISMATCH")
        self.assertEqual(calls, [])
        self.args.output_dir = self.folder / "third-candidate"
        report = self.run_checks(self.transport(state_after=STATE.replace(b"7361722", b"7361723")), runner)
        self.assertEqual(report["osm"]["errorCode"], "OSM_SOURCE_CHANGED_DURING_DOWNLOAD")
        self.assertEqual(calls, [])

    def test_legacy_baseline_cannot_produce_claim_of_like_for_like_camera_changes(self):
        self.args.download_osm = True
        self.osm.pop("kind")
        self.osm["pbfMd5"] = self.osm.pop("inputMd5")
        self.baselines()
        candidate = {**self.osm, "kind": "osm-camera-source", "inputMd5": MD5}
        report = self.run_checks(runner=lambda command: self.runner(command, candidate))
        self.assertIsNone(report["osm"]["cameraFactsChanged"])
        self.assertIn("Legacy baseline", report["osm"]["note"])

    def test_baseline_scope_and_normalizer_identity_fail_closed(self):
        self.osm["region"] = "another-region"
        self.baselines()
        report = self.run_checks()
        self.assertEqual(report["errors"][0]["code"], "OSM_BASELINE_SCHEMA")
        self.args.output_dir = self.folder / "second-candidate"
        self.osm["region"] = "RU-KLU"
        self.args.download_osm = True
        self.baselines()
        candidate = {**self.osm, "region": "another-region"}
        report = self.run_checks(runner=lambda command: self.runner(command, candidate))
        self.assertEqual(report["osm"]["errorCode"], "OSM_NORMALIZED_SCHEMA")

    def test_workflow_is_manual_readonly_and_actions_are_pinned(self):
        workflow = (CHECK.ROOT / ".github/workflows/camera-source-check.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+(schedule|push|pull_request|workflow_run):")
        self.assertIn("contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        actions = re.findall(r"uses: (actions/[^\s]+)", workflow)
        self.assertEqual(len(actions), 3)
        for action in actions:
            self.assertRegex(action, r"^actions/[a-z-]+@[a-f0-9]{40}$")
        self.assertIn("if: inputs.download_osm", workflow)
        self.assertNotIn("npm install", workflow)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("git push", workflow)


if __name__ == "__main__":
    unittest.main()
