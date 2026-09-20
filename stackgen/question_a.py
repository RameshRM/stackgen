"""Question A: which EC2 instances are running, and does the supplied
Terraform state hold a managed-resource binding for them?

Mirrors stackgen/js/solution-a.js.
"""

import json

from . import loader


def filter_by_env(environment, entries):
    return [e for e in entries if e["scope"].get("environment") == environment]


def tf_entries(tf_snapshots):
    """Split the Terraform side into what we could search and what we could not."""
    searched = []
    not_supplied = []
    for item in tf_snapshots:
        entry = dict(item)
        if entry["status"] == "success":
            entry["payload"] = loader.load_payload(entry["payload_path"])
            searched.append(entry)
        else:
            not_supplied.append(entry)
    return {
        "searched": searched,
        "notSupplied": not_supplied,
        "index": build_tf_index(searched),
    }


def build_tf_index(searched):
    """instance id -> the state records that reference it."""
    index = {}
    for entry in searched:
        for i, resource in enumerate(entry["payload"]["resources"]):
            if resource["type"] != "aws_instance":
                continue
            index.setdefault(resource["values"]["id"], []).append({
                "address": resource["address"],
                "mode": resource["mode"],
                "workspace_id": entry["scope"].get("workspace_id"),
                "__ref": {
                    "source_file": entry["payload_path"],
                    "locator": "/resources/%d" % i,
                    "observed_at": entry["observed_at"],
                    "freshness_budget_seconds": entry["freshness_budget_seconds"],
                },
            })
    return index


def classify(instance, index, searched):
    """The three verdicts the brief asks us to tell apart."""
    if len(searched) == 0:
        # nothing was searched, so neither other verdict can be claimed
        return {"verdict": "evidence_unavailable", "reason": None, "records": None}

    matches = index.get(instance["InstanceId"], [])
    managed = [m for m in matches if m["mode"] == "managed"]

    if len(managed) > 0:
        return {"verdict": "binding_found", "reason": None, "records": managed}
    if len(matches) > 0:
        # present, but only as a data source: a read, not a management claim
        return {
            "verdict": "no_binding_found",
            "reason": "referenced_as_data_source_only",
            "records": matches,
        }
    return {
        "verdict": "no_binding_found",
        "reason": "absent_from_supplied_state",
        "records": None,
    }


def build_limitations(binding, tf, evaluated_at):
    limitations = []
    if binding["verdict"] == "evidence_unavailable":
        limitations.append("no_terraform_state_supplied_for_this_scope")
        return limitations
    for entry in tf["searched"]:
        # equality is within budget, per the extract notes
        age = loader.age_seconds(entry["observed_at"], evaluated_at)
        if age > entry["freshness_budget_seconds"]:
            limitations.append("terraform_state_observed_past_its_freshness_budget")
    if len(tf["notSupplied"]) > 0:
        limitations.append("some_terraform_workspaces_in_scope_not_supplied")
    return limitations


def answer(tenant, environment):
    aws_snapshots = filter_by_env(environment, loader.find_manifest(tenant, "aws"))
    tf_snapshots = filter_by_env(environment, loader.find_manifest(tenant, "terraform"))

    tf = tf_entries(tf_snapshots)
    index = tf["index"]
    evaluated_at = loader.as_of()
    results = []

    for snapshot in aws_snapshots:
        if snapshot["status"] != "success":
            continue
        payload = loader.load_payload(snapshot["payload_path"])
        for ci, collection in enumerate(payload["collections"]):
            if collection["snapshot_id"] != snapshot["snapshot_id"]:
                continue
            for i, instance in enumerate(collection["instances"]):
                if instance["State"]["Name"] != "running":
                    continue
                binding = classify(instance, index, tf["searched"])
                results.append({
                    "instance_id": instance["InstanceId"],
                    "account_id": snapshot["scope"]["account_id"],
                    "region": snapshot["scope"]["region"],
                    "observed_running": {
                        "state": instance["State"]["Name"],
                        "environment": snapshot["scope"]["environment"],
                        "__ref": {
                            "source_file": snapshot["payload_path"],
                            "locator": "/collections/%d/instances/%d" % (ci, i),
                            "observed_at": snapshot["observed_at"],
                        },
                    },
                    "terraform_binding": binding,
                    "limitations": build_limitations(binding, tf, evaluated_at),
                })

    results.sort(key=lambda r: r["instance_id"])

    return {
        "query": {"tenant_id": tenant, "environment": environment},
        "evaluated_at": evaluated_at,
        "results": results,
        "scope": {
            "terraform_workspaces_searched": [
                e["scope"].get("workspace_id") for e in tf["searched"]
            ],
            "terraform_workspaces_not_supplied": [
                e["scope"].get("workspace_id") for e in tf["notSupplied"]
            ],
        },
    }


def main():
    defaults = loader.query_defaults()
    print(json.dumps(
        answer(defaults["tenant_id"], defaults["environment"]), indent=2))


if __name__ == "__main__":
    main()
