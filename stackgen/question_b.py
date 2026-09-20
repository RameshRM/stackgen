"""Question B: for a catalog application, its declared dependencies and the
supported path from its workloads through Kubernetes Nodes to cloud resources.

Mirrors stackgen/js/solution-b.js.
"""

import json

from . import loader

RULES = loader.reasoning()


def get_aws_inventory(tenant, environment):
    """EC2 records for this tenant and environment, each stamped with a
    reference back to where it came from."""
    snapshots = [
        e for e in loader.find_manifest(tenant, "aws")
        if e["scope"].get("environment") == environment and e["status"] == "success"
    ]
    by_id = {e["snapshot_id"]: e for e in snapshots}

    out = []
    for ci, collection in enumerate(loader.AWS["collections"]):
        snapshot = by_id.get(collection["snapshot_id"])
        if snapshot is None:
            continue
        for i, item in enumerate(collection["instances"]):
            item["__ref"] = {
                "source_file": "aws_inventory.json",
                "locator": "/collections/%d/instances/%d" % (ci, i),
                "observed_at": snapshot["observed_at"],
                "freshness_budget_seconds": snapshot["freshness_budget_seconds"],
            }
            out.append(item)
    return out


def get_aws_databases(tenant, environment):
    snapshots = [
        e for e in loader.find_manifest(tenant, "aws")
        if e["scope"].get("environment") == environment and e["status"] == "success"
    ]
    allowed = set(e["snapshot_id"] for e in snapshots)

    out = []
    for collection in loader.AWS["collections"]:
        if collection["snapshot_id"] in allowed:
            out.extend(collection["databases"])
    return out


def get_tf_state(tenant, environment):
    snapshots = [
        e for e in loader.find_manifest(tenant, "terraform")
        if e["scope"].get("environment") == environment and e["status"] == "success"
    ]
    if len(snapshots) == 0:
        return []                       # nothing searched, not "nothing found"
    snapshot = snapshots[0]
    payload = loader.load_payload(snapshot["payload_path"])

    out = []
    for i, item in enumerate(payload["resources"]):
        item["__ref"] = {
            "source_file": snapshot["payload_path"],
            "locator": "/resources/%d" % i,
            "observed_at": snapshot["observed_at"],
            "freshness_budget_seconds": snapshot["freshness_budget_seconds"],
        }
        out.append(item)
    return out


def find_catalogues(service_name, environment, tenant):
    """Catalog rows for this application, inside this tenant's collections."""
    allowed = {
        e["snapshot_id"]: e
        for e in loader.find_manifest(tenant, "catalog")
        if e["status"] == "success"
    }
    rows = []
    for row in loader.load_csv("service_catalog.csv"):
        snapshot = allowed.get(row["snapshot_id"])
        if snapshot is None:
            continue
        if row["service_name"] != service_name:
            continue
        if row["environment"] != environment:
            continue
        row["__ref"]["observed_at"] = snapshot["observed_at"]
        rows.append(row)
    return rows


def has_owner_ref(owner_references, parent_uid):
    for owner in owner_references or []:
        if owner["uid"] == parent_uid:
            return True
    return False


def get_deployment(deployments, service_name):
    selected = [
        d for d in deployments
        if d["spec"]["selector"]["matchLabels"]["app"] == service_name
    ]
    return selected[0] if selected else None


def get_replicasets(deployment, replicasets, service_name):
    return [
        rs for rs in replicasets
        if rs["spec"]["selector"]["matchLabels"]["app"] == service_name
        and has_owner_ref(rs["metadata"].get("ownerReferences"),
                          deployment["metadata"]["uid"])
    ]


def get_pods(replicaset, pods, service_name):
    return [
        pod for pod in pods
        if pod["metadata"].get("labels", {}).get("app") == service_name
        and has_owner_ref(pod["metadata"].get("ownerReferences"),
                          replicaset["metadata"]["uid"])
    ]


def get_nodes(pod, nodes):
    return [n for n in nodes if n["metadata"]["name"] == pod["spec"]["nodeName"]]


def get_instance_id(node):
    """providerID is optional; an omitted one is not an empty instance id."""
    if node is None:
        return None
    provider_id = node.get("spec", {}).get("providerID")
    if not provider_id:
        return None
    return provider_id.split("/")[-1]


def stop_reason(node):
    if node is None:
        return "node_not_in_supplied_collection"
    if not node.get("spec", {}).get("providerID"):
        return "node_has_no_provider_reference"
    return None


def get_inventory_by_instance(inventory, instance_id):
    return [i for i in inventory if i["InstanceId"] == instance_id]


def aws_team(inventory, tag_key):
    values = []
    for item in inventory:
        for tag in item.get("Tags", []):
            if tag["Key"] == tag_key:
                values.append(tag["Value"])
    return values


def get_tf_entry(tf_resources, tag_key, instance_id):
    """The state record for one instance, plus the team it names."""
    entry = {"team": {}, "__ref": None}
    for resource in tf_resources:
        values = resource.get("values", {})
        if values.get("id") == instance_id and values.get("tags"):
            entry["__ref"] = resource["__ref"]
            entry["team"][values["tags"].get(tag_key)] = 1
    return entry


def team_claims(matched, tf_entry):
    """What each source says about who operates the instance.

    A conflict is Terraform declaring an operator the instance does not carry.
    AWS holding tags Terraform never mentions is not a conflict: Terraform
    only speaks for what it declares.
    """
    aws_teams = aws_team(matched, "operator_team")
    tf_teams = list(tf_entry["team"].keys())
    return {
        "aws": aws_teams,
        "tf": tf_teams,
        "haveConflict": any(t not in aws_teams for t in tf_teams),
    }


def resolve_dependency(arn, databases, instances, tenant, environment):
    # a blank cell means the catalog supplied no dependency, not that none exists
    if not arn:
        return {"arn": None, "resolved": False, "reason": "not_supplied_by_catalog"}

    service = arn.split(":")[2]

    if service == "rds":
        # database ARNs are supplied directly by the inventory
        matches = [db for db in databases if db["DBInstanceArn"] == arn]
        if len(matches) == 0:
            return {"arn": arn, "type": "rds", "resolved": False,
                    "reason": "target_not_in_supplied_inventory"}
        found = dict(RULES["arn:database"])
        found.update({"arn": arn, "type": "rds", "resolved": True,
                      "db_identifier": matches[0]["DBInstanceIdentifier"],
                      "status": matches[0]["DBInstanceStatus"]})
        return found

    if service == "ec2":
        # EC2 records carry no ARN, so build it from the snapshot's account
        # and region, per the extract notes
        snapshots = [
            e for e in loader.find_manifest(tenant, "aws")
            if e["scope"].get("environment") == environment and e["status"] == "success"
        ]
        matches = []
        for instance in instances:
            for snapshot in snapshots:
                built = "arn:aws:ec2:%s:%s:instance/%s" % (
                    snapshot["scope"]["region"],
                    snapshot["scope"]["account_id"],
                    instance["InstanceId"])
                if built == arn:
                    matches.append(instance)
        if len(matches) == 0:
            return {"arn": arn, "type": "ec2", "resolved": False,
                    "reason": "target_not_in_supplied_inventory"}
        found = dict(RULES["node:instance"])
        found.update({"arn": arn, "type": "ec2", "resolved": True,
                      "instance_id": matches[0]["InstanceId"],
                      "status": matches[0]["State"]["Name"]})
        return found

    # we did not search: saying "not found" would overstate the evidence
    return {"arn": arn, "type": service, "resolved": False,
            "reason": "unsupported_dependency_type"}


def claim(fields, rule_key):
    """One reported value, with what kind of claim it is."""
    out = dict(fields)
    out.update(RULES[rule_key])
    return out


def answer(tenant, environment, application):
    evaluated_at = loader.as_of()
    query = {"tenant_id": tenant, "environment": environment,
             "application_name": application}

    catalogues = find_catalogues(application, environment, tenant)
    if len(catalogues) == 0:
        return {"query": query, "evaluated_at": evaluated_at,
                "verdict": "evidence_unavailable",
                "reason": "no catalog row for this application in this tenant"}
    app_catalog = catalogues[0]

    snapshots = [
        e for e in loader.find_manifest(tenant, "kubernetes")
        if e["scope"].get("cluster_id") == app_catalog["cluster_id"]
    ]
    snapshot = snapshots[0] if snapshots else None

    if snapshot is None or snapshot["status"] != "success":
        return {"query": query, "evaluated_at": evaluated_at,
                "verdict": "evidence_unavailable",
                "reason": "no kubernetes collection supplied for this tenant and cluster"}

    by_kind = loader.find_k8s({snapshot["snapshot_id"]: snapshot}, app_catalog)
    deployment = get_deployment(by_kind.get("Deployment", []), application)
    replicasets = get_replicasets(deployment, by_kind.get("ReplicaSet", []), application)
    pods = get_pods(replicasets[0], by_kind.get("Pod", []), application)

    inventory = get_aws_inventory(tenant, environment)
    tf_state = get_tf_state(tenant, environment)
    databases = get_aws_databases(tenant, environment)

    # pod -> node -> cloud instance
    paths = []
    for pod in pods:
        nodes = get_nodes(pod, by_kind.get("Node", []))
        node = nodes[0] if nodes else None
        instance_id = get_instance_id(node)
        matched = get_inventory_by_instance(inventory, instance_id)
        tf_entry = get_tf_entry(tf_state, "operator_team", instance_id)

        # other workloads on the same node: co-location, not a dependency
        shared = [
            p["metadata"]["name"] for p in by_kind.get("Pod", [])
            if p["spec"]["nodeName"] == pod["spec"]["nodeName"]
            and p["metadata"]["uid"] != pod["metadata"]["uid"]
        ]

        paths.append({
            "pod": claim({"name": pod["metadata"]["name"], "__ref": pod["__ref"]},
                         "replicaset:pod"),
            "namespace": pod["metadata"]["namespace"],
            "node": claim({"name": pod["spec"]["nodeName"],
                           "__ref": node["__ref"] if node else None,
                           "found": node is not None},
                          "pod:node"),
            "sharedNodeWorkloads": shared,
            "provider_id": node.get("spec", {}).get("providerID") if node else None,
            "instance": claim({"id": instance_id,
                               "__ref": matched[0]["__ref"] if matched else None},
                              "node:instance"),
            "stops_at": stop_reason(node),
            "tf": claim({"__ref": tf_entry["__ref"]}, "instance:operator_team"),
            "team": team_claims(matched, tf_entry),
        })

    return {
        "query": query,
        "evaluated_at": evaluated_at,
        "application": claim({"name": app_catalog["service_id"],
                              "__ref": app_catalog["__ref"]}, "catalog:application"),
        "owner_team": claim({"value": app_catalog["owner_team"]}, "catalog:application"),
        "cluster": claim({"value": app_catalog["cluster_id"]}, "catalog:application"),
        "namespace": claim({"value": app_catalog["namespace"]}, "catalog:application"),
        "deployment": claim({"name": deployment["metadata"]["name"] if deployment else None,
                             "__ref": deployment["__ref"] if deployment else None},
                            "catalog:deployment"),
        "replicaset": claim({"name": replicasets[0]["metadata"]["name"] if replicasets else None,
                             "__ref": replicasets[0]["__ref"] if replicasets else None},
                            "deployment:replicaset"),
        "declared_dependencies": [
            resolve_dependency(app_catalog["declared_dependency_arn"], databases,
                               inventory, tenant, environment)
        ],
        "paths": paths,
    }


def main():
    defaults = loader.query_defaults()
    print(json.dumps(answer(defaults["tenant_id"], defaults["environment"],
                            defaults["application_name"]), indent=2))


if __name__ == "__main__":
    main()
