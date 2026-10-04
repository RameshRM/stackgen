"""One file, every DAG.

Airflow parses this on each refresh and emits one DAG per deployment spec in the
store. A file per spec would mean a thousand deployments are a thousand files for
the processor to parse; this is one query, and the dags folder never grows.

Each DAG holds the whole sequence — deploy, gate, promote — so the graph in
Airflow is the chain that actually happens. An earlier version split at every
gate into a DAG each, on the belief that waiting for a person would otherwise
hold a worker. A sensor in reschedule mode releases its worker between pokes, so
the split bought nothing and cost the one thing an orchestrator is for: seeing
the whole thing at once.

The plan is the spec's own sequence. Nothing is precomputed here and nothing is
precomputed in the control plane either, so there is no second description of the
order to drift from the first.
"""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

import pendulum

try:
    from airflow.sdk import DAG
except ImportError:  # pragma: no cover - Airflow 2
    from airflow import DAG
try:
    from airflow.providers.standard.operators.python import PythonOperator
    from airflow.providers.standard.sensors.python import PythonSensor
except ImportError:  # pragma: no cover - Airflow 2
    from airflow.operators.python import PythonOperator
    from airflow.sensors.python import PythonSensor

import factory_db
from factory import gate_passed, open_gate, provision_observability, request_action

FACTORY_ROOT = Path(os.environ.get(
    "FACTORY_ROOT",
    Path(__file__).resolve().parents[2],
))

START = pendulum.datetime(2026, 1, 1, tz="UTC")

# How long a gate may stay open before the run gives up. A person taking a week
# is not a failure, but "forever" is not a decision either — and a run that has
# been open indefinitely is one nobody is looking at.
GATE_TIMEOUT = timedelta(days=7)
GATE_POKE_SECONDS = 30

# Actions that put something in the cluster, and therefore leave something to
# observe. An action absent from this set is real work — it just is not work
# that produces a scrape target.
OBSERVABLE = {"deploy", "promote"}


def build(spec):
    """One DAG for one deployment spec: the whole graph, as the spec describes it.

    Edges come from each step's `needs`, which the control plane resolved into the
    spec. So a sequence that forks renders as a fork, and steps that do not depend
    on each other run at the same time. Walking the list and chaining each step to
    the one before it — which is what this did first — can only ever draw a line,
    whatever the operation actually looks like.
    """
    with DAG(
        dag_id=spec["dag_id"],
        # triggered by the control plane, never on a clock
        schedule=None,
        start_date=START,
        catchup=False,
        tags=["factory", spec["blueprint"], spec["team"]],
        doc_md=(
            f"`{spec['id']}`, from `{spec['blueprint']}` "
            f"v{spec['blueprint_version']}, targeting {spec.get('type')}.\n\n"
            "Generated from the deployment spec. Do not edit in Airflow: a change "
            "belongs in the blueprint, and produces a new spec."
        ),
    ) as dag:
        # the task that stands for each step, and the task an edge should point at
        tasks = {}
        ends_at = {}

        for index, step in enumerate(spec.get("sequence", [])):
            step_id = step["id"]

            if step.get("gate"):
                # A gate is a wait, not work. In reschedule mode the task frees
                # its worker between pokes, so a gate open for a week costs a row
                # in the metadata database and nothing else.
                task = PythonSensor(
                    task_id=step_id,
                    python_callable=gate_passed,
                    mode="reschedule",
                    poke_interval=GATE_POKE_SECONDS,
                    timeout=GATE_TIMEOUT.total_seconds(),
                    op_kwargs={
                        "spec_id": spec["id"],
                        "team": spec["team"],
                        "gate": step["gate"],
                        "approver_role": step.get("approver_role"),
                        "step_index": index,
                    },
                )
                tasks[step_id] = task
                ends_at[step_id] = task
                continue

            action = PythonOperator(
                task_id=step_id,
                python_callable=request_action,
                op_kwargs={
                    "spec_id": spec["id"],
                    "team": spec["team"],
                    "action": step["action"],
                    "environment": step["environment"],
                    "step_index": index,
                },
            )
            tasks[step_id] = action
            ends_at[step_id] = action

            if step["action"] not in OBSERVABLE:
                # Scaffolding a repository or building an image puts nothing in
                # the cluster, so there is nothing to scrape and no alert rule
                # that would mean anything. Observing every action regardless is
                # what left a run waiting on a target that would never appear.
                continue

            # Provisioning the means of noticing comes after the action, because
            # there is nothing to scrape until the pods exist. It installs the
            # alert rules the acceptance block describes; nothing evaluates them,
            # because a threshold is crossed whenever it is crossed and not at
            # the moment a workflow happens to look.
            observe = PythonOperator(
                task_id=f"observe_{step_id}",
                python_callable=provision_observability,
                op_kwargs={
                    "spec_id": spec["id"],
                    "team": spec["team"],
                    "environment": step["environment"],
                },
            )
            action >> observe

            # anything waiting on this step waits for its observation too, so a
            # gate cannot be reached before the thing it is gating is watched
            ends_at[step_id] = observe

        for step in spec.get("sequence", []):
            for need in step.get("needs", []):
                if need in ends_at:
                    ends_at[need] >> tasks[step["id"]]

    return dag


def runnable(spec) -> str:
    """Why this spec cannot be built, or an empty string.

    A deployment spec is immutable, so a spec written before the sequence carried
    ids and dependencies will always be missing them. Such a spec is skipped with
    a reason rather than allowed to raise: one old document must not take every
    other DAG down with it, which is exactly what it did the first time.
    """
    if not spec.get("dag_id"):
        return "it names no dag_id"
    steps = spec.get("sequence") or []
    if not steps:
        return "its sequence is empty"
    missing = [i for i, step in enumerate(steps) if not step.get("id")]
    if missing:
        return (f"steps {missing} carry no id, so this spec predates dependencies"
                " in the sequence")
    return ""


# Airflow discovers a DAG by finding it in this module's globals.
_connection = factory_db.open_db()
try:
    for _spec in factory_db.list_specs(_connection):
        _why = runnable(_spec)
        if _why:
            print(f"[factory] skipping {_spec.get('id')}: {_why}")
            continue
        globals()[_spec["dag_id"]] = build(_spec)
finally:
    _connection.close()
