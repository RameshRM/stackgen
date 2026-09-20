"""Tests for both questions.

Each test names the implementation error it would catch, so a failure points
at a decision rather than just a value.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stackgen import issues, loader, question_a, question_b   # noqa: E402


def by_instance(answer):
    return {r["instance_id"]: r for r in answer["results"]}


class JustifiedMatch(unittest.TestCase):
    """Cross-source matches the evidence supports, end to end."""

    def test_managed_binding_is_found_and_cited(self):
        # Catches: matching on the wrong field, or reporting a verdict without
        # the workspace and observation time the brief asks for.
        row = by_instance(question_a.answer("acme", "prod"))["i-00000000000000101"]
        binding = row["terraform_binding"]

        self.assertEqual(binding["verdict"], "binding_found")
        record = binding["records"][0]
        self.assertEqual(record["address"], "module.workers.aws_instance.pool[0]")
        self.assertEqual(record["mode"], "managed")
        self.assertEqual(record["workspace_id"], "acme-prod-core")
        self.assertEqual(record["__ref"]["locator"], "/resources/0")
        self.assertEqual(record["__ref"]["observed_at"], "2026-09-02T09:00:00Z")

    def test_workload_path_reaches_the_cloud_instance(self):
        # Catches: a broken hop in catalog -> Deployment -> ReplicaSet -> Pod
        # -> Node -> instance, or a providerID parsed wrongly.
        answer = question_b.answer("acme", "prod", "payments-api")

        self.assertEqual(answer["owner_team"]["value"], "team-payments")
        self.assertEqual(answer["deployment"]["name"], "payments-api")
        self.assertEqual(answer["replicaset"]["name"], "payments-api-7c9d")
        reached = [(p["pod"]["name"], p["instance"]["id"]) for p in answer["paths"]]
        self.assertEqual(reached, [
            ("payments-api-7c9d-a", "i-00000000000000101"),
            ("payments-api-7c9d-b", "i-00000000000000102"),
        ])

    def test_declared_dependency_resolves_to_a_supplied_record(self):
        # Catches: reporting the declared ARN without checking it exists.
        answer = question_b.answer("acme", "prod", "payments-api")
        dependency = answer["declared_dependencies"][0]

        self.assertTrue(dependency["resolved"])
        self.assertEqual(dependency["db_identifier"], "payments-db")
        self.assertEqual(dependency["stated_by"], "derived")

    def test_stopped_instance_is_not_reported_as_running(self):
        # Catches: filtering on the wrong state field, or not filtering at all.
        answer = question_a.answer("acme", "prod")
        self.assertNotIn("i-00000000000000106", by_instance(answer))
        self.assertEqual(len(answer["results"]), 5)


class MisleadingSimilarity(unittest.TestCase):
    """Records that look like the same thing but are not."""

    def test_same_instance_id_in_two_tenants_stays_separate(self):
        # i-00000000000000101 is supplied under acme AND bravo, in the same
        # AWS account. Catches: keying on the provider id alone, which would
        # hand bravo acme's Terraform evidence.
        acme = by_instance(question_a.answer("acme", "prod"))
        bravo = by_instance(question_a.answer("bravo", "prod"))

        shared = "i-00000000000000101"
        self.assertEqual(acme[shared]["terraform_binding"]["verdict"], "binding_found")
        self.assertEqual(bravo[shared]["terraform_binding"]["verdict"],
                         "evidence_unavailable")
        self.assertNotIn("acme", json.dumps(bravo[shared]))

    def test_same_dependency_arn_does_not_cross_tenants(self):
        # acme and bravo declare the identical RDS ARN, but only acme's
        # inventory contains the database. Catches: matching the ARN without
        # scoping the inventory to the tenant.
        acme = question_b.answer("acme", "prod", "payments-api")
        self.assertTrue(acme["declared_dependencies"][0]["resolved"])

        databases = question_b.get_aws_databases("bravo", "prod")
        resolved = question_b.resolve_dependency(
            "arn:aws:rds:us-east-1:111111111111:db:payments-db",
            databases, [], "bravo", "prod")
        self.assertFalse(resolved["resolved"])
        self.assertEqual(resolved["reason"], "target_not_in_supplied_inventory")

    def test_staging_resources_stay_out_of_the_prod_answer(self):
        # worker-a exists in prod and staging, and a payments-api Deployment
        # exists in both clusters. Catches: selecting collections by tenant
        # only, ignoring environment and cluster.
        answer = question_a.answer("acme", "prod")
        self.assertNotIn("i-00000000000000201", by_instance(answer))
        self.assertEqual(answer["scope"]["terraform_workspaces_searched"],
                         ["acme-prod-core"])

        paths = question_b.answer("acme", "prod", "payments-api")["paths"]
        for path in paths:
            self.assertEqual(path["namespace"], "production")


class QualifiedUncertainty(unittest.TestCase):
    """Cases that must stay qualified rather than becoming facts."""

    def test_data_source_is_not_a_managed_binding(self):
        # i-00000000000000103 appears in the state as mode=data. Catches:
        # treating any state record as management evidence.
        row = by_instance(question_a.answer("acme", "prod"))["i-00000000000000103"]
        binding = row["terraform_binding"]

        self.assertEqual(binding["verdict"], "no_binding_found")
        self.assertEqual(binding["reason"], "referenced_as_data_source_only")
        # the data record is still cited, as evidence of what was found
        self.assertEqual(binding["records"][0]["mode"], "data")

    def test_missing_collection_is_not_reported_as_no_binding(self):
        # bravo's Terraform state has status not_provided. Catches: treating
        # an uncollected scope as an empty one, which would imply the instance
        # is unmanaged.
        answer = question_a.answer("bravo", "prod")
        row = answer["results"][0]

        self.assertEqual(row["terraform_binding"]["verdict"], "evidence_unavailable")
        self.assertIn("no_terraform_state_supplied_for_this_scope", row["limitations"])
        self.assertEqual(answer["scope"]["terraform_workspaces_not_supplied"],
                         ["bravo-prod-core"])

    def test_conflicting_operator_claims_are_both_reported(self):
        # AWS says team-platform for i-...101; Terraform says
        # team-legacy-platform. Catches: preferring one source and silently
        # dropping the other.
        paths = question_b.answer("acme", "prod", "payments-api")["paths"]
        first = [p for p in paths if p["instance"]["id"] == "i-00000000000000101"][0]
        second = [p for p in paths if p["instance"]["id"] == "i-00000000000000102"][0]

        self.assertEqual(first["team"]["aws"], ["team-platform"])
        self.assertEqual(first["team"]["tf"], ["team-legacy-platform"])
        self.assertTrue(first["team"]["haveConflict"])

        # agreement is not flagged
        self.assertEqual(second["team"]["aws"], second["team"]["tf"])
        self.assertFalse(second["team"]["haveConflict"])

    def test_stale_state_is_flagged_on_every_affected_row(self):
        # acme's state was observed 14 days before as_of, against a 1-day
        # budget. Catches: using the wall clock instead of the manifest's
        # as_of, or reporting staleness only once in a footer.
        answer = question_a.answer("acme", "prod")
        self.assertEqual(answer["evaluated_at"], "2026-09-16T12:00:00Z")

        for row in answer["results"]:
            self.assertIn("terraform_state_observed_past_its_freshness_budget",
                          row["limitations"],
                          "%s is missing the staleness limitation" % row["instance_id"])

        stale = [i for i in issues.report()["issues"]
                 if i["issue"] == "collection_past_freshness_budget"]
        self.assertEqual(stale[0]["observation_age_seconds"], 1220400.0)

    def test_derived_claims_are_marked_apart_from_source_statements(self):
        # Catches: presenting a five-hop conclusion the same way as a value a
        # file states directly.
        answer = question_b.answer("acme", "prod", "payments-api")
        path = answer["paths"][0]

        self.assertEqual(answer["owner_team"]["stated_by"], "source")
        self.assertEqual(path["node"]["stated_by"], "source")
        self.assertEqual(path["instance"]["stated_by"], "derived")
        self.assertIn("providerID", path["instance"]["rule"])

    def test_co_located_workload_is_shown_but_not_claimed_as_a_dependency(self):
        # billing-api runs on the same node as payments-api. Catches: treating
        # node sharing as a dependency or a responsibility.
        paths = question_b.answer("acme", "prod", "payments-api")["paths"]
        first = [p for p in paths if p["node"]["name"] == "ip-10-0-4-118"][0]

        self.assertEqual(first["sharedNodeWorkloads"], ["billing-api-7c9d-a"])
        self.assertNotIn("billing-api-7c9d-a",
                         json.dumps(question_b.answer("acme", "prod",
                                                      "payments-api")["declared_dependencies"]))


class IssuesReport(unittest.TestCase):
    """Gaps in the evidence are surfaced, not silently dropped."""

    def test_managed_resource_with_no_inventory_record_is_reported(self):
        # i-00000000000000099 is managed in acme-prod-core but appears in no
        # supplied inventory. Catches: an issues report that only walks the
        # cloud side and never notices state-only resources.
        found = [i for i in issues.report()["issues"]
                 if i["issue"] == "managed_resource_absent_from_inventory"]

        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["instance_id"], "i-00000000000000099")
        self.assertIn("resolved_by", found[0])

    def test_uncollected_collections_are_reported(self):
        # Catches: an issues report built only from loaded files, which would
        # never mention the collections that were never supplied.
        found = [i["snapshot_id"] for i in issues.report()["issues"]
                 if i["issue"] == "collection_not_supplied"]
        self.assertEqual(sorted(found),
                         ["k8s-bravo-prod-20260916", "tf-bravo-prod-20260916"])


class Repeatability(unittest.TestCase):
    """Reprocessing the same input must not change anything."""

    def test_answers_are_identical_when_recomputed(self):
        # Catches: identity derived from iteration order, mutation of the
        # loaded files across calls, or duplicate entities on a second pass.
        for first, second in [
            (question_a.answer("acme", "prod"), question_a.answer("acme", "prod")),
            (question_b.answer("acme", "prod", "payments-api"),
             question_b.answer("acme", "prod", "payments-api")),
            (issues.report(), issues.report()),
        ]:
            self.assertEqual(json.dumps(first, sort_keys=True),
                             json.dumps(second, sort_keys=True))

    def test_evaluation_time_comes_from_the_manifest(self):
        # Catches: datetime.now() anywhere, which would make every other test
        # depend on the day it is run.
        self.assertEqual(loader.as_of(), "2026-09-16T12:00:00Z")
        self.assertEqual(question_a.answer("acme", "prod")["evaluated_at"],
                         loader.as_of())
        self.assertEqual(
            question_b.answer("acme", "prod", "payments-api")["evaluated_at"],
            loader.as_of())


if __name__ == "__main__":
    unittest.main(verbosity=2)
