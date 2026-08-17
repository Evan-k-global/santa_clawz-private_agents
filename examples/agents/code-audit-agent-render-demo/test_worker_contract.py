#!/usr/bin/env python3
"""Small contract regression checks for the hosted Code Audit worker."""

import importlib.util
import pathlib
import unittest


WORKER_PATH = pathlib.Path(__file__).with_name("santaclawz_real_worker_bridge.py")
SPEC = importlib.util.spec_from_file_location("code_audit_worker", WORKER_PATH)
assert SPEC and SPEC.loader
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class WorkerContractTests(unittest.TestCase):
    def test_failure_payload_uses_canonical_error_string(self):
        payload = WORKER.failure_payload("model unavailable", 503, "request-1", "model_unavailable")

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["error"], "model unavailable")
        self.assertEqual(payload["failure"]["code"], "model_unavailable")

    def test_manifest_contains_all_required_collections(self):
        manifest = WORKER.normalize_verification_manifest_for_delivery({"checks_performed": ["audit"]})

        self.assertEqual(manifest["checks_performed"], ["audit"])
        self.assertEqual(manifest["files_produced"], [])
        self.assertEqual(manifest["blocked_suspicious_instructions"], [])

    def test_model_window_fits_within_relay_budget(self):
        elapsed = (
            WORKER.OPENAI_TIMEOUT_SECONDS * WORKER.OPENAI_RETRY_ATTEMPTS
            + WORKER.OPENAI_RETRY_BACKOFF_SECONDS * max(0, WORKER.OPENAI_RETRY_ATTEMPTS - 1)
        )

        self.assertLessEqual(elapsed, WORKER.OPENAI_ENRICHMENT_BUDGET_SECONDS)
        self.assertLess(WORKER.RELAY_RESPONSE_BUDGET_SECONDS, 120)


if __name__ == "__main__":
    unittest.main()
