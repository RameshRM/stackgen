"""Shared access to the supplied files.

Mirrors stackgen/js/loader.js: both questions read the manifest through here,
so tenant scope is applied the same way in each.
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def read_json(relative_path):
    with open(os.path.join(ROOT, relative_path), encoding="utf-8") as handle:
        return json.load(handle)


MANIFEST = read_json("manifest.json")
K8S = read_json("k8s_resources.json")
AWS = read_json("aws_inventory.json")


def query_defaults():
    return MANIFEST["query_defaults"]


def as_of():
    """The fixed evaluation time. Never the computer's clock."""
    return MANIFEST["as_of"]


def find_manifest(tenant, source_family):
    """Snapshots for one tenant and family, supplied or not.

    An entry with status not_provided is kept: a collection that was never
    collected is a gap in evidence, not an empty inventory.
    """
    return [
        entry for entry in MANIFEST["snapshots"]
        if entry["source_family"] == source_family and entry["tenant_id"] == tenant
    ]


def load_payload(payload_path):
    return read_json(payload_path)


def find_k8s(snapshot_id_set, app_catalog):
    """Kubernetes objects for the chosen collections, grouped by kind."""
    items = []
    for ci, collection in enumerate(K8S["collections"]):
        snapshot = snapshot_id_set.get(collection["snapshot_id"])
        if snapshot is None:
            continue
        for i, item in enumerate(collection["items"]):
            item["__ref"] = {
                "source_file": "k8s_resources.json",
                "locator": "/collections/%d/items/%d" % (ci, i),
                "observed_at": snapshot["observed_at"],
            }
            items.append(item)

    by_kind = {}
    for item in items:
        if item["kind"] != "Node":
            # namespace filtering applies to namespaced kinds; Nodes are
            # cluster-scoped and carry no namespace
            if item["metadata"].get("namespace") != app_catalog["namespace"]:
                continue
        by_kind.setdefault(item["kind"], []).append(item)
    return by_kind


def reasoning():
    """What each claim in an answer is: stated by a source, or worked out here."""
    return {
        "replicaset:pod": {
            "stated_by": "derived",
            "rule": "Pod ownerReferences uid matches the ReplicaSet uid",
        },
        "pod:node": {
            "stated_by": "source",
            "rule": "the Pod states its own spec.nodeName",
        },
        "node:instance": {
            "stated_by": "derived",
            "rule": "providerID last segment matched to InstanceId within tenant, account and region",
        },
        "arn:database": {
            "stated_by": "derived",
            "rule": "declared ARN matched to DBInstanceArn within this tenant and environment",
        },
        "instance:operator_team": {
            "stated_by": "source",
            "rule": "the record states the operator_team tag directly",
        },
        "catalog:application": {
            "stated_by": "source",
            "rule": "stated directly by the catalog row",
        },
        "catalog:deployment": {
            "stated_by": "source",
            "rule": "the catalog row names cluster_id, namespace and deployment_name",
        },
        "deployment:replicaset": {
            "stated_by": "derived",
            "rule": "ReplicaSet ownerReferences uid matches the Deployment uid",
        },
    }


def load_csv(file_name):
    """One row per line. A blank cell means not supplied, never an empty claim."""
    with open(os.path.join(ROOT, file_name), encoding="utf-8") as handle:
        lines = handle.read().split("\n")
    header = lines[0].strip().split(",")
    rows = []
    for i in range(1, len(lines)):
        if lines[i].strip() == "":
            continue
        cols = lines[i].strip().split(",")
        row = {}
        for j, column in enumerate(header):
            value = cols[j] if j < len(cols) else ""
            row[column] = None if value == "" else value
        row["__ref"] = {
            "source_file": file_name,
            "locator": "row=%d" % (i + 1),
        }
        rows.append(row)
    return rows


def age_seconds(observed_at, evaluated_at):
    """Seconds between an observation and the evaluation time."""
    from datetime import datetime

    def parse(text):
        return datetime.fromisoformat(text.replace("Z", "+00:00"))

    return (parse(evaluated_at) - parse(observed_at)).total_seconds()
