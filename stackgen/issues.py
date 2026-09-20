"""Issues report: unresolved links, conflicting observations, and coverage or
freshness limits that change how the answers should be read.

Each issue says what would resolve it.
"""

import json

from . import loader


def collections_not_supplied():
    """Declared in the manifest, never collected.

    The difference between "we looked and found nothing" and "we never looked".
    """
    issues = []
    for snapshot in loader.MANIFEST["snapshots"]:
        if snapshot["status"] == "success":
            continue
        issues.append({
            "issue": "collection_not_supplied",
            "severity": "high",
            "snapshot_id": snapshot["snapshot_id"],
            "source_family": snapshot["source_family"],
            "tenant_id": snapshot["tenant_id"],
            "status": snapshot["status"],
            "coverage": snapshot["coverage"],
            "detail": ("No payload was supplied, so nothing in this scope was "
                       "searched. Absence of a result here is not evidence of "
                       "absence."),
            "resolved_by": ("A successful collection for this scope, at which "
                            "point results become findings rather than unknowns."),
        })
    return issues


def stale_collections():
    """Observed longer ago than the collection's own freshness budget."""
    evaluated_at = loader.as_of()
    issues = []
    for snapshot in loader.MANIFEST["snapshots"]:
        if snapshot["status"] != "success":
            continue
        age = loader.age_seconds(snapshot["observed_at"], evaluated_at)
        budget = snapshot["freshness_budget_seconds"]
        if age <= budget:                     # equality is within budget
            continue
        issues.append({
            "issue": "collection_past_freshness_budget",
            "severity": "high" if age > budget * 5 else "medium",
            "snapshot_id": snapshot["snapshot_id"],
            "source_family": snapshot["source_family"],
            "tenant_id": snapshot["tenant_id"],
            "observed_at": snapshot["observed_at"],
            "observation_age_seconds": age,
            "freshness_budget_seconds": budget,
            "detail": ("Values in this collection describe the world at %s, not "
                       "at the evaluation time. Claims derived from it are "
                       "historical." % snapshot["observed_at"]),
            "resolved_by": "A fresher collection for the same scope.",
        })
    return issues


def managed_resources_without_inventory():
    """A managed resource whose provider object is in no supplied inventory.

    Either the object is gone, or it sits outside every collected inventory
    scope. The supplied evidence cannot tell those apart.
    """
    issues = []
    for snapshot in loader.MANIFEST["snapshots"]:
        if snapshot["source_family"] != "terraform" or snapshot["status"] != "success":
            continue
        known = inventory_ids(snapshot)
        payload = loader.load_payload(snapshot["payload_path"])
        for i, resource in enumerate(payload["resources"]):
            if resource["mode"] != "managed" or resource["type"] != "aws_instance":
                continue
            if resource["values"]["id"] in known:
                continue
            issues.append({
                "issue": "managed_resource_absent_from_inventory",
                "severity": "medium",
                "instance_id": resource["values"]["id"],
                "address": resource["address"],
                "workspace_id": snapshot["scope"].get("workspace_id"),
                "tenant_id": snapshot["tenant_id"],
                "snapshot_id": snapshot["snapshot_id"],
                "source_file": snapshot["payload_path"],
                "locator": "/resources/%d" % i,
                "observed_at": snapshot["observed_at"],
                "detail": ("Terraform holds a managed record for this instance, "
                           "but no supplied cloud inventory in the same tenant, "
                           "account and region contains it."),
                "resolved_by": ("A cloud inventory covering this account and "
                                "region with no instance-id filter, or a "
                                "fresher state."),
            })
    return issues


def inventory_ids(terraform_snapshot):
    """Instance ids from every cloud collection sharing this tenant, account
    and region -- the scope in which a provider id is meaningful."""
    ids = set()
    for snapshot in loader.MANIFEST["snapshots"]:
        if snapshot["source_family"] != "aws" or snapshot["status"] != "success":
            continue
        if snapshot["tenant_id"] != terraform_snapshot["tenant_id"]:
            continue
        if snapshot["scope"].get("account_id") != terraform_snapshot["scope"].get("account_id"):
            continue
        if snapshot["scope"].get("region") != terraform_snapshot["scope"].get("region"):
            continue
        for collection in loader.AWS["collections"]:
            if collection["snapshot_id"] != snapshot["snapshot_id"]:
                continue
            for instance in collection["instances"]:
                ids.add(instance["InstanceId"])
    return ids


def identifiers_reused():
    """The same provider identifier supplied under more than one collection.

    Matching on the identifier alone would merge two tenants' resources.
    """
    by_snapshot = {
        s["snapshot_id"]: s for s in loader.MANIFEST["snapshots"]
        if s["source_family"] == "aws" and s["status"] == "success"
    }
    seen = {}
    for collection in loader.AWS["collections"]:
        snapshot = by_snapshot.get(collection["snapshot_id"])
        if snapshot is None:
            continue
        for instance in collection["instances"]:
            seen.setdefault(instance["InstanceId"], []).append(snapshot)
        for database in collection["databases"]:
            seen.setdefault(database["DBInstanceIdentifier"], []).append(snapshot)

    issues = []
    for identifier in sorted(seen):
        snapshots = seen[identifier]
        if len(snapshots) < 2:
            continue
        issues.append({
            "issue": "identifier_reused_across_collections",
            "severity": "medium",
            "identifier": identifier,
            "appears_in": [{
                "snapshot_id": s["snapshot_id"],
                "tenant_id": s["tenant_id"],
                "account_id": s["scope"].get("account_id"),
                "region": s["scope"].get("region"),
                "environment": s["scope"].get("environment"),
            } for s in snapshots],
            "detail": ("This identifier is supplied by more than one collection. "
                       "It is unique only within its own tenant, account and "
                       "region, so those must be part of any match."),
            "resolved_by": ("No further evidence needed. This is a property of "
                            "the identifier space, and is handled by scoping "
                            "matches."),
        })
    return issues


def report():
    issues = []
    issues.extend(collections_not_supplied())
    issues.extend(stale_collections())
    issues.extend(managed_resources_without_inventory())
    issues.extend(identifiers_reused())
    return {
        "evaluated_at": loader.as_of(),
        "issue_count": len(issues),
        "issues": issues,
    }


def main():
    print(json.dumps(report(), indent=2))


if __name__ == "__main__":
    main()
