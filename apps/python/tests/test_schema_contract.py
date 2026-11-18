"""SC-10 schema contract regression harness.

Makes schema and fixture correctness a permanent, CI-enforced invariant:
every registered schema must exist, be a valid Draft 2020-12 schema, and
every fixture case must behave as its `valid` flag expects.

Run through the repository's existing Python test step:
    node scripts/run-python.mjs -m unittest discover -s apps/python/tests
"""
from pathlib import Path
import json
import tempfile
import unittest

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "schemas"
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures"

# Explicit register. A schema missing from disk fails the run; nothing is
# silently skipped and no unregistered schema is picked up by globbing.
REGISTERED_SCHEMAS = [
    "work-item",
    "message",
    "identity",
    "provenance",
    "issue",
    "result",
    "task",
    "delegation-ledger",
    "conflict-record",
    "policy-conflict",
    "authorization-reference",
    "artifact-record",
]


def run_contract(schema_path, fixture_path):
    """Return a list of mismatch strings; empty means the contract holds."""
    mismatches = []
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    fixture = json.loads(Path(fixture_path).read_text(encoding="utf-8"))
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as error:  # noqa: BLE001 - reported as a mismatch
        return [f"schema definition invalid: {error}"]
    validator = Draft202012Validator(schema)
    for case in fixture.get("cases", []):
        errors = list(validator.iter_errors(case["instance"]))
        accepted = not errors
        if accepted != case["valid"]:
            mismatches.append(
                f"{case['name']}: expected valid={case['valid']}, "
                f"got accepted={accepted} ({len(errors)} errors)"
            )
    return mismatches


class SchemaContractTest(unittest.TestCase):
    def test_registered_schemas_and_fixtures_exist(self):
        for name in REGISTERED_SCHEMAS:
            with self.subTest(schema=name):
                self.assertTrue((SCHEMA_DIR / f"{name}.schema.json").is_file(), f"missing schema {name}")
                self.assertTrue((FIXTURE_DIR / f"{name}.json").is_file(), f"missing fixture {name}")

    def test_every_registered_schema_contract_holds(self):
        for name in REGISTERED_SCHEMAS:
            with self.subTest(schema=name):
                mismatches = run_contract(
                    SCHEMA_DIR / f"{name}.schema.json",
                    FIXTURE_DIR / f"{name}.json",
                )
                self.assertEqual(mismatches, [], f"{name}: {mismatches}")

    def test_no_unregistered_fixture_is_silently_ignored(self):
        expected = {f"{name}.json" for name in REGISTERED_SCHEMAS}
        present = {path.name for path in FIXTURE_DIR.glob("*.json")}
        self.assertEqual(present, expected, f"unregistered or missing fixtures: {sorted(present ^ expected)}")

    def test_harness_detects_a_wrong_expectation(self):
        """Negative self-test on temporary data; authoritative fixtures untouched."""
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://multi-parent-runtime.local/schemas/__selftest__.schema.json",
            "type": "object",
            "additionalProperties": False,
            "required": ["kind"],
            "properties": {"kind": {"type": "string", "enum": ["ok"]}},
        }
        fixture = {
            "schema": schema["$id"],
            "cases": [
                {"name": "deliberately-wrong", "valid": False, "instance": {"kind": "ok"}, "expect": "accept"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            schema_path = Path(tmp) / "schema.json"
            fixture_path = Path(tmp) / "fixture.json"
            schema_path.write_text(json.dumps(schema), encoding="utf-8")
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
            mismatches = run_contract(schema_path, fixture_path)
        self.assertTrue(mismatches, "harness failed to detect a wrong expectation")


if __name__ == "__main__":
    unittest.main()
