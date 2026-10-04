"""The shared store, from Python.

Airflow and the control plane open the same SQLite file and run the same
schema script, so the schema is written once rather than once per language.

Airflow opens gates; it does not decide them. Deciding is the control plane's,
so the conditional update that settles a gate lives in db.js and not here —
the same rule in two languages is the same rule until one of them drifts.

Named factory_db rather than db because the dags folder is on sys.path and a
module called db there would be a collision waiting to happen.
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

FACTORY_ROOT = Path(os.environ.get(
    "FACTORY_ROOT",
    Path(__file__).resolve().parents[2],
))

SCHEMA = FACTORY_ROOT / "control-plane" / "db" / "schema.sql"


def path() -> Path:
    override = os.environ.get("FACTORY_DB")
    if override:
        return Path(override)
    return FACTORY_ROOT / "var" / "factory.db"


def open_db() -> sqlite3.Connection:
    target = path()
    target.parent.mkdir(parents=True, exist_ok=True)
    # a writer in the other process may hold the lock
    connection = sqlite3.connect(target, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    connection.commit()
    return connection


def append_audit(connection, record: dict) -> None:
    principal = record.get("principal", {})
    target = record.get("target")
    detail = record.get("detail")
    connection.execute(
        "INSERT INTO audit (spec_id, at, principal_id, principal_type,"
        " principal_team, action, decision, reason, target_json, detail_json)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            record.get("spec_id") or (target or {}).get("spec_id"),
            record["at"],
            principal.get("id"),
            principal.get("type"),
            principal.get("team"),
            record["action"],
            record["decision"],
            record.get("reason"),
            json.dumps(target) if target is not None else None,
            json.dumps(detail) if detail is not None else None,
        ),
    )
    connection.commit()


def read_spec(connection, spec_id: str) -> dict:
    """The deployment spec this DAG was generated from.

    The spec carries its own boundaries, so a later blueprint edit cannot
    change how a run already in flight is judged.
    """
    import yaml

    row = connection.execute(
        "SELECT spec_yaml FROM deployment_spec WHERE id = ?", (spec_id,)).fetchone()
    if row is None:
        raise ValueError(f"no deployment spec {spec_id}")
    return yaml.safe_load(row["spec_yaml"])


def list_specs(connection) -> list:
    """Every deployment spec, oldest first.

    A spec that will not parse is skipped rather than breaking the DAG parse:
    one malformed document should not take every other DAG down with it.
    """
    import yaml

    specs = []
    for row in connection.execute(
            "SELECT id, spec_yaml FROM deployment_spec ORDER BY id"):
        try:
            specs.append(yaml.safe_load(row["spec_yaml"]))
        except Exception as error:  # pragma: no cover - defensive
            print(f"[factory] skipping spec {row['id']}: {error}")
    return specs


def open_approval(connection, spec_id, gate, approver_role, next_dag_id, opened_at) -> str:
    """Open a gate, once.

    DO NOTHING on conflict is the point: a retried stage must not open a second
    row, and must not reset an approval that already happened back to pending.
    Returns what the gate is now, which is not always what this call asked for.
    """
    connection.execute(
        "INSERT INTO approval (spec_id, gate, approver_role, next_dag_id,"
        " state, opened_at) VALUES (?, ?, ?, ?, 'pending', ?)"
        " ON CONFLICT (spec_id, gate) DO NOTHING",
        (spec_id, gate, approver_role, next_dag_id, opened_at),
    )
    connection.commit()
    row = connection.execute(
        "SELECT state FROM approval WHERE spec_id = ? AND gate = ?",
        (spec_id, gate)).fetchone()
    return row["state"]


def read_approval(connection, spec_id, gate):
    return connection.execute(
        "SELECT * FROM approval WHERE spec_id = ? AND gate = ?",
        (spec_id, gate)).fetchone()
