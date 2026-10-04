"""Asking whether an action is permitted.

The worker sends what it intends to do and who it is. It does not send the
evidence that would justify it: the approvals live in the engine, put there by
the control plane, so a worker cannot assert that its own gate was passed.

Unreachable is cannot_tell, never allow. A control plane that acts when it
cannot reach its policy engine has no policy engine.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

OPA_URL = os.environ.get("OPA_URL", "http://127.0.0.1:8181")
DECISION = "/v1/data/factory/decision"
TIMEOUT_SECONDS = 5

WORKER = {"id": "airflow-worker", "type": "agent"}


def decide(spec_id, action, environment=None, principal=None, gate=None):
    """Ask the engine. Returns {"result": ..., "reason": ...}."""
    payload = {"input": {
        "spec_id": spec_id,
        "action": action,
        "principal": principal or WORKER,
    }}
    if environment is not None:
        payload["input"]["environment"] = environment
    if gate is not None:
        payload["input"]["gate"] = gate

    request = urllib.request.Request(
        OPA_URL + DECISION,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"result": "cannot_tell",
                "reason": f"the policy engine at {OPA_URL} could not be reached: {error}"}
    except json.JSONDecodeError as error:
        return {"result": "cannot_tell",
                "reason": f"the policy engine returned something unreadable: {error}"}

    decision = body.get("result")
    if not decision or "result" not in decision:
        # an empty result means the rule did not evaluate, which is not an allow
        return {"result": "cannot_tell",
                "reason": "the policy returned no decision"}
    return decision
