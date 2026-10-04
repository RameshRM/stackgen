"""What Airflow does to a gate: open it, wait at it, and never decide it.

Deciding is the control plane's, so the conditional update that settles a gate
lives in db.js and is tested there, against real concurrent processes. What is
tested here is the half Airflow owns — opening the gate, and the sensor that
waits at it.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "orchestrator" / "dags"))


class OpeningAGate(unittest.TestCase):

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        os.environ["FACTORY_DB"] = str(Path(self.directory.name) / "factory.db")

        import factory_db
        connection = factory_db.open_db()
        connection.execute(
            "INSERT INTO deployment_spec (id, blueprint, blueprint_version,"
            " app_name, team, created_by, created_at, dag_id, spec_yaml)"
            " VALUES ('spec-gate', 'deploy-service', '1.0.0', 'hello', 'payments',"
            " 'alice@acme.com', '2026-09-28T00:00:00Z', 'spec_gate', 'id: spec-gate')")
        connection.commit()
        self.connection = connection

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()
        os.environ.pop("FACTORY_DB", None)

    def open_gate(self, at="2026-09-28T00:00:00Z"):
        import factory_db
        return factory_db.open_approval(
            self.connection, "spec-gate", "promotion_approval",
            "release-manager", "spec_gate", at)

    def test_opening_a_gate_leaves_it_pending(self):
        self.assertEqual(self.open_gate(), "pending")

    # Catches: an Airflow retry resetting a gate someone already decided, which
    # would ask for a second approval and lose the name of the first approver.
    def test_a_retried_stage_cannot_reopen_a_decided_gate(self):
        import factory_db
        self.open_gate()
        self.connection.execute(
            "UPDATE approval SET state = 'approved', decided_by = 'alice@acme.com'"
            " WHERE spec_id = 'spec-gate' AND gate = 'promotion_approval'")
        self.connection.commit()

        state = self.open_gate(at="2026-09-28T00:02:00Z")

        self.assertEqual(state, "approved")
        row = factory_db.read_approval(self.connection, "spec-gate", "promotion_approval")
        self.assertEqual(row["decided_by"], "alice@acme.com")

    # Catches: a gate recorded against a spec that is not there, which would be
    # an approval releasing a stage nothing can run.
    def test_a_gate_cannot_name_a_spec_that_does_not_exist(self):
        import factory_db
        with self.assertRaises(sqlite3.IntegrityError):
            factory_db.open_approval(
                self.connection, "spec-absent", "promotion_approval",
                "release-manager", "spec_absent", "2026-09-28T00:00:00Z")


class WaitingAtAGate(unittest.TestCase):
    """The sensor. It reads a decision; it never makes one."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        os.environ["FACTORY_DB"] = str(Path(self.directory.name) / "factory.db")

        import factory_db
        self.connection = factory_db.open_db()
        self.connection.execute(
            "INSERT INTO deployment_spec (id, blueprint, blueprint_version,"
            " app_name, team, created_by, created_at, dag_id, spec_yaml)"
            " VALUES ('spec-gate', 'deploy-service', '1.0.0', 'hello', 'payments',"
            " 'alice@acme.com', '2026-09-28T00:00:00Z', 'spec_gate', 'id: spec-gate')")
        self.connection.commit()

    def tearDown(self):
        self.connection.close()
        self.directory.cleanup()
        os.environ.pop("FACTORY_DB", None)

    def poke(self):
        import factory
        return factory.gate_passed(
            spec_id="spec-gate", team="payments", gate="promotion_approval",
            approver_role="release-manager", step_index=1)

    def decide(self, state, who="alice@acme.com"):
        self.connection.execute(
            "UPDATE approval SET state = ?, decided_by = ?, decided_at = ?"
            " WHERE spec_id = 'spec-gate' AND gate = 'promotion_approval'",
            (state, who, "2026-09-28T00:01:00Z"))
        self.connection.commit()

    # Catches: a gate nobody can decide because nothing opened it. The first poke
    # is what makes the decision visible to a person.
    def test_the_first_poke_opens_the_gate(self):
        import factory_db
        self.assertIsNone(
            factory_db.read_approval(self.connection, "spec-gate", "promotion_approval"))

        self.assertFalse(self.poke())

        row = factory_db.read_approval(self.connection, "spec-gate", "promotion_approval")
        self.assertEqual(row["state"], "pending")
        self.assertEqual(row["approver_role"], "release-manager")

    # Catches: a poke that advances the run before anyone decided.
    def test_a_pending_gate_keeps_waiting(self):
        self.poke()
        self.assertFalse(self.poke())
        self.assertFalse(self.poke())

    def test_an_approved_gate_lets_the_run_continue(self):
        self.poke()
        self.decide("approved")
        self.assertTrue(self.poke())

    # Catches: a rejection being treated as "not yet". Waiting would burn the
    # timeout and report the gate as slow rather than as refused.
    def test_a_rejected_gate_stops_the_run(self):
        from airflow.exceptions import AirflowException

        self.poke()
        self.decide("rejected", who="dana@acme.com")

        with self.assertRaises(AirflowException) as caught:
            self.poke()
        self.assertIn("rejected by dana@acme.com", str(caught.exception))

    # Catches: repeated pokes resetting a decided gate, which would ask for a
    # second approval and lose the name of the first approver.
    def test_poking_a_decided_gate_does_not_reopen_it(self):
        import factory_db

        self.poke()
        self.decide("approved")
        self.poke()
        self.poke()

        row = factory_db.read_approval(self.connection, "spec-gate", "promotion_approval")
        self.assertEqual(row["state"], "approved")
        self.assertEqual(row["decided_by"], "alice@acme.com")


if __name__ == "__main__":
    unittest.main()
