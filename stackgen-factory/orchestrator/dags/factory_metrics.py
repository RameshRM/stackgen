"""Provisioning the means of measuring, and then measuring.

A blueprint may declare acceptance. Something has to be able to answer the
question it asks, so the workflow provisions that something rather than assuming
it: `ensure_prometheus` applies the manifests, and `wait_for_target` refuses to
continue until this deployment's own pods are being scraped.

That order matters. Discovering at judgement time that nothing was collected is
indistinguishable from discovering that nothing went wrong, and those are not
the same fact.

The dimensions a query needs — spec, blueprint, team — are attached by
Prometheus at scrape time from the pod's Kubernetes labels, which the deployment
spec's kustomize tree set. The application emits none of them. An application
asked to label its own metrics with a deployment spec id is one that can forget
to, and one that can claim a spec it was not deployed by.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FACTORY_ROOT = Path(os.environ.get(
    "FACTORY_ROOT",
    Path(__file__).resolve().parents[2],
))

MANIFESTS = FACTORY_ROOT / "orchestrator" / "observability" / "prometheus.yaml"
QUERIES = FACTORY_ROOT / "orchestrator" / "queries"
NAMESPACE = "factory-observability"

# How the orchestrator reaches Prometheus.
#
# Through the Kubernetes API server's service proxy by default, because that
# needs nothing but the kubeconfig that is already required to deploy. A
# NodePort only reaches the host if the cluster was created with a port mapping,
# and on kind that is decided at creation time — so relying on it would mean
# rebuilding the cluster to add observability.
#
# Set PROMETHEUS_URL to talk to it directly where that is possible.
PROMETHEUS_URL = os.environ.get("PROMETHEUS_URL")
PROXY_PATH = (f"/api/v1/namespaces/{NAMESPACE}/services/prometheus:9090/proxy")

READY_TIMEOUT_SECONDS = int(os.environ.get("PROMETHEUS_READY_TIMEOUT", "180"))
TARGET_TIMEOUT_SECONDS = int(os.environ.get("PROMETHEUS_TARGET_TIMEOUT", "120"))


def _kubectl(args, **kwargs):
    return subprocess.run(["kubectl"] + args, capture_output=True, text=True, **kwargs)


def ensure_prometheus() -> dict:
    """Apply the observability stack. Idempotent: applying it again changes nothing."""
    applied = _kubectl(["apply", "-f", str(MANIFESTS)])
    if applied.returncode != 0:
        raise RuntimeError(f"could not apply the observability stack: {applied.stderr.strip()}")

    lines = [line for line in applied.stdout.strip().split("\n") if line]

    ready = _kubectl([
        "rollout", "status", "deployment/prometheus",
        "-n", NAMESPACE, f"--timeout={READY_TIMEOUT_SECONDS}s",
    ])
    if ready.returncode != 0:
        raise RuntimeError(f"prometheus did not become ready: {ready.stderr.strip()}")

    return {"applied": lines, "url": where()}


def where() -> str:
    """Where Prometheus is being asked, for a message a human can act on."""
    return PROMETHEUS_URL or f"the api server proxy at {PROXY_PATH}"


def query_path(path: str) -> dict:
    """GET one of Prometheus's own paths. Returns the parsed body, or raises."""
    if PROMETHEUS_URL:
        try:
            with urllib.request.urlopen(PROMETHEUS_URL + path, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise RuntimeError(f"prometheus at {PROMETHEUS_URL} could not be reached: {error}")

    asked = _kubectl(["get", "--raw", PROXY_PATH + path])
    if asked.returncode != 0:
        raise RuntimeError(
            f"prometheus could not be reached through {where()}: {asked.stderr.strip()[:200]}")
    try:
        return json.loads(asked.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"prometheus returned something unreadable: {error}")


def query(expression: str) -> dict:
    """Ask Prometheus a promql question."""
    return query_path("/api/v1/query?" + urllib.parse.urlencode({"query": expression}))


def scraped_targets(spec_id: str, namespace: str) -> int:
    """How many of this deployment's pods Prometheus currently reports as up."""
    expression = f'up{{spec="{spec_id}",namespace="{namespace}"}}'
    body = query(expression)
    results = body.get("data", {}).get("result", [])
    return sum(1 for r in results if r.get("value", [None, "0"])[1] == "1")


def wait_for_target(spec_id: str, namespace: str, timeout: int | None = None) -> dict:
    """Refuse to continue until this deployment is actually being scraped.

    Without this the acceptance check would run against an empty series and
    report cannot_tell, which is honest but useless: the cause would be a
    missing scrape config nobody looked at. Failing here names the cause.
    """
    deadline = time.time() + (timeout or TARGET_TIMEOUT_SECONDS)
    seen = 0
    while time.time() < deadline:
        seen = scraped_targets(spec_id, namespace)
        if seen > 0:
            return {"targets_up": seen, "namespace": namespace}
        time.sleep(3)

    raise RuntimeError(
        f"no pod of {spec_id} in {namespace} is being scraped after "
        f"{timeout or TARGET_TIMEOUT_SECONDS}s; acceptance could not be measured")


def render_query(name: str, values: dict) -> str:
    """Fill a .promql file's placeholders from the deployment spec."""
    path = QUERIES / f"{name}.promql"
    if not path.is_file():
        raise ValueError(f"no query file at {path}")

    text = "\n".join(
        line for line in path.read_text(encoding="utf-8").splitlines()
        if not line.strip().startswith("#")
    ).strip()

    def substitute(match):
        key = match.group(1).strip()
        if key not in values:
            raise ValueError(f"{path.name} wants {{{{ {key} }}}}, which the spec does not supply")
        return str(values[key])

    return re.sub(r"\{\{([^}]+)\}\}", substitute, text)


# A blueprint's acceptance expression, as a comparison of a metric to a number.
# Parsed rather than evaluated: a blueprint is a document an author edits, and
# running it as code would make editing one a way to run code here.
COMPARISON = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=|<|>|==)\s*([0-9.eE+-]+)\s*$")

# An acceptance criterion says what good looks like. An alert fires on the
# opposite, so the operator is negated when the rule is generated.
NEGATION = {"<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!="}

RULES_CONFIGMAP = "factory-rules"


def alert_rules(spec: dict) -> dict:
    """The Prometheus rule group a deployment spec's acceptance block describes.

    Nothing here judges anything. A criterion is a threshold, so it becomes an
    alerting rule that fires if and when the threshold is crossed — at three in
    the morning next Tuesday, if that is when it happens. Evaluating it once at
    deploy time would answer a question nobody asked and would be answering it
    about a deployment that has not yet been used.

    The expression comes from the criterion's own .promql file, rendered with
    this spec's dimensions. The threshold and the window come from the
    blueprint. The comparison is negated: `error_rate < 0.01` is the condition
    for being well, and an alert fires on being unwell.
    """
    namespace = None
    for step in spec.get("sequence", []):
        if step.get("namespace"):
            namespace = step["namespace"]
            break

    rules = []
    for criterion in spec.get("acceptance", []):
        match = COMPARISON.match(criterion["expression"])
        if not match:
            raise ValueError(
                f"acceptance expression {criterion['expression']!r} is not a comparison"
                " of a metric to a number, which is all this understands")

        _, operator, threshold = match.groups()
        window = criterion.get("window", "5m")

        measurement = render_query(criterion["id"], {
            "spec_id": spec["id"],
            "blueprint": spec["blueprint"],
            "namespace": namespace,
            "window": window,
        })

        rules.append({
            "alert": f"{spec['id']}_{criterion['id']}",
            "expr": f"({measurement}) {NEGATION[operator]} {threshold}",
            # `for` is how long the condition must hold. A deployment serving no
            # requests produces no samples, the expression is absent rather than
            # false, and nothing fires — which is the right silence.
            "for": window,
            "labels": {
                "severity": criterion.get("severity", "warning"),
                "spec": spec["id"],
                "blueprint": spec["blueprint"],
                "team": spec["team"],
            },
            "annotations": {
                "criterion": criterion["id"],
                "acceptance": criterion["expression"],
                "summary": f"{spec['id']} breached {criterion['expression']}",
            },
        })

    return {"groups": [{"name": spec["id"], "rules": rules}]} if rules else {"groups": []}


def install_rules(spec: dict) -> dict:
    """Put a spec's generated rules into Prometheus.

    One ConfigMap key per deployment spec, so provisioning one spec cannot
    disturb another's rules. Prometheus is then asked to reload rather than
    restarted, which is why it runs with the lifecycle endpoint enabled.
    """
    import yaml

    document = alert_rules(spec)
    if not document["groups"]:
        return {"rules": 0, "reloaded": False}

    key = f"{spec['id']}.yaml"
    patch = json.dumps({"data": {key: yaml.safe_dump(document, sort_keys=False)}})

    patched = _kubectl([
        "patch", "configmap", RULES_CONFIGMAP, "-n", NAMESPACE,
        "--type", "merge", "-p", patch,
    ])
    if patched.returncode != 0:
        raise RuntimeError(f"could not write the alert rules: {patched.stderr.strip()[:200]}")

    # The file has to be in the pod before a reload means anything, and a rule
    # that was written but never loaded is an alert nobody will get.
    arrived = wait_for_rule_file(key)
    if not arrived:
        raise RuntimeError(
            f"{key} was written to the {RULES_CONFIGMAP} configmap but had not"
            " reached the prometheus pod; the alert rules are not live")

    if not reload_prometheus():
        raise RuntimeError("prometheus refused to reload, so the new alert rules"
                           " are on disk but not in effect")

    live = [r["name"] for r in loaded_rules(spec["id"])]
    return {
        "rules": len(document["groups"][0]["rules"]),
        "key": key,
        "loaded": live,
    }


def wait_for_rule_file(key: str, timeout: int = 120) -> bool:
    """Wait until the generated rule file is visible inside the pod.

    A ConfigMap change reaches the mounted volume on the kubelet's schedule, not
    immediately. Reloading before the file is there reloads the old set and
    reports success, so the rule would silently not exist.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        present = _kubectl([
            "exec", "-n", NAMESPACE, "deploy/prometheus",
            "--", "test", "-f", f"/etc/prometheus/rules/{key}",
        ])
        if present.returncode == 0:
            return True
        time.sleep(3)
    return False


def reload_prometheus() -> bool:
    """Ask Prometheus to re-read its rule files.

    `/-/reload` is POST-only, so this is `kubectl create --raw`, not `get`.
    Reaching it with GET returns an error that looks like a failed reload while
    changing nothing — which is what this did at first.
    """
    asked = _kubectl(["create", "--raw", PROXY_PATH + "/-/reload", "-f", "/dev/null"])
    return asked.returncode == 0


def firing_alerts(spec_id: str) -> list:
    """The alerts currently firing for one deployment spec."""
    body = query_path("/api/v1/alerts")
    return [
        {
            "name": alert.get("labels", {}).get("alertname"),
            "state": alert.get("state"),
            "since": alert.get("activeAt"),
            "value": alert.get("value"),
            "criterion": alert.get("annotations", {}).get("criterion"),
            "acceptance": alert.get("annotations", {}).get("acceptance"),
        }
        for alert in body.get("data", {}).get("alerts", [])
        if alert.get("labels", {}).get("spec") == spec_id
    ]


def loaded_rules(spec_id: str) -> list:
    """The rules Prometheus has actually loaded for one spec."""
    body = query_path("/api/v1/rules")
    out = []
    for group in body.get("data", {}).get("groups", []):
        if group.get("name") != spec_id:
            continue
        for rule in group.get("rules", []):
            out.append({
                "name": rule.get("name"),
                "state": rule.get("state"),
                "health": rule.get("health"),
                "criterion": rule.get("annotations", {}).get("criterion"),
                "acceptance": rule.get("annotations", {}).get("acceptance"),
            })
    return out
