"""Rendering a query, and judging what it returned.

The parts that talk to Prometheus are exercised end to end against a real
cluster. What is tested here is the reasoning either side of that call, because
those are where a wrong answer looks like a right one: a query with an
unsubstituted placeholder matches nothing and reads as a healthy deployment, and
an empty result read as zero passes a workload nobody has ever used.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "orchestrator" / "dags"))

import factory_metrics  # noqa: E402


VALUES = {
    "spec_id": "spec-0001",
    "blueprint": "deploy-service",
    "namespace": "payments-staging",
    "window": "2m",
}


class RenderingAQuery(unittest.TestCase):

    def test_the_dimensions_reach_the_query(self):
        rendered = factory_metrics.render_query("error_rate", VALUES)
        self.assertIn('spec="spec-0001"', rendered)
        self.assertIn('blueprint="deploy-service"', rendered)
        self.assertIn('namespace="payments-staging"', rendered)
        self.assertIn("[2m]", rendered)

    # Catches: a placeholder surviving into the query. It would match no series,
    # return nothing, and read as a deployment with no errors.
    def test_nothing_unsubstituted_survives(self):
        rendered = factory_metrics.render_query("error_rate", VALUES)
        self.assertNotIn("{{", rendered)

    # Catches: a query wanting something the spec does not supply being rendered
    # with a blank, which silently widens the query to every deployment.
    def test_a_missing_value_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            factory_metrics.render_query("error_rate", {"spec_id": "spec-0001"})
        self.assertIn("blueprint", str(caught.exception))

    def test_comments_are_not_part_of_the_query(self):
        rendered = factory_metrics.render_query("error_rate", VALUES)
        self.assertFalse(any(line.strip().startswith("#") for line in rendered.splitlines()))

    def test_a_query_that_does_not_exist_is_refused(self):
        with self.assertRaises(ValueError):
            factory_metrics.render_query("no_such_query", VALUES)


class GeneratingAlertRules(unittest.TestCase):
    """An acceptance criterion is a threshold, so it becomes an alerting rule."""

    def spec(self, expression="error_rate < 0.01", window="15s"):
        return {
            "id": "spec-rule",
            "blueprint": "hello-world",
            "team": "payments",
            "sequence": [{"action": "deploy", "environment": "staging",
                          "namespace": "payments-staging"}],
            "acceptance": [{"id": "error_rate", "expression": expression,
                            "window": window}],
        }

    def rule(self, **kwargs):
        return factory_metrics.alert_rules(self.spec(**kwargs))["groups"][0]["rules"][0]

    # Catches the inversion. `error_rate < 0.01` is the condition for being well;
    # an alert has to fire on the opposite. Getting this backwards produces a
    # rule that fires constantly while everything is fine.
    def test_the_comparison_is_negated(self):
        self.assertIn(">= 0.01", self.rule()["expr"])
        self.assertIn("> 0.01", self.rule(expression="error_rate <= 0.01")["expr"])
        self.assertIn("<= 0.5", self.rule(expression="error_rate > 0.5")["expr"])
        self.assertIn("< 0.5", self.rule(expression="error_rate >= 0.5")["expr"])
        self.assertIn("!= 0", self.rule(expression="error_rate == 0")["expr"])

    # Catches: a rule that matches every deployment in the cluster.
    def test_the_rule_is_scoped_to_one_spec(self):
        expr = self.rule()["expr"]
        self.assertIn('spec="spec-rule"', expr)
        self.assertIn('blueprint="hello-world"', expr)
        self.assertIn('namespace="payments-staging"', expr)

    # Catches: an alert that fires on a single scrape. The window is how long the
    # condition must hold, and the blueprint is what says so.
    def test_the_window_becomes_for(self):
        self.assertEqual(self.rule()["for"], "15s")
        self.assertEqual(self.rule(window="5m")["for"], "5m")

    # Catches: an alert nobody can trace back to what asked for it.
    def test_the_rule_names_what_it_came_from(self):
        rule = self.rule()
        self.assertEqual(rule["annotations"]["criterion"], "error_rate")
        self.assertEqual(rule["annotations"]["acceptance"], "error_rate < 0.01")
        self.assertEqual(rule["labels"]["spec"], "spec-rule")
        self.assertEqual(rule["labels"]["team"], "payments")

    # Catches: a group name that collides, so provisioning one spec overwrites
    # the rules of another.
    def test_the_group_is_named_for_the_spec(self):
        self.assertEqual(
            factory_metrics.alert_rules(self.spec())["groups"][0]["name"], "spec-rule")

    def test_a_spec_with_no_acceptance_generates_no_rules(self):
        spec = self.spec()
        spec["acceptance"] = []
        self.assertEqual(factory_metrics.alert_rules(spec)["groups"], [])

    # Catches: the expression being evaluated rather than parsed. A blueprint is
    # a document an author edits; running it as code would make editing one a
    # way to run code here.
    def test_an_expression_that_is_not_a_comparison_is_refused(self):
        for hostile in ['__import__("os").system("id")', "error_rate < 0.01 or True"]:
            with self.assertRaises(ValueError, msg=hostile):
                factory_metrics.alert_rules(self.spec(expression=hostile))


class TheRuleIsValidPromql(unittest.TestCase):

    # Catches: a generated rule Prometheus will not load. Nothing downstream
    # reads it but Prometheus, so promtool is the only way to know.
    def test_promtool_accepts_the_generated_rules(self):
        import subprocess
        import yaml

        spec = {
            "id": "spec-rule", "blueprint": "hello-world", "team": "payments",
            "sequence": [{"action": "deploy", "environment": "staging",
                          "namespace": "payments-staging"}],
            "acceptance": [{"id": "error_rate", "expression": "error_rate < 0.01",
                            "window": "15s"}],
        }
        document = yaml.safe_dump(factory_metrics.alert_rules(spec), sort_keys=False)

        checked = subprocess.run(
            ["promtool", "check", "rules", "/dev/stdin"],
            input=document, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0,
                         checked.stdout + checked.stderr)


if __name__ == "__main__":
    unittest.main()
