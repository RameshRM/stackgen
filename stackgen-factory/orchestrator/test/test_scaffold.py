"""Creating the microservice, twice.

Airflow retries tasks. So the question that matters is not whether scaffolding
works, but what happens the second time — and the answer has to be different
depending on who is asking.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "orchestrator" / "dags"))

import factory_scaffold  # noqa: E402


class Scaffolding(unittest.TestCase):

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original = factory_scaffold.REPOS
        factory_scaffold.REPOS = Path(self.directory.name) / "repos"
        factory_scaffold.FACTORY_ROOT = Path(self.directory.name)

    def tearDown(self):
        factory_scaffold.REPOS = self.original
        self.directory.cleanup()

    def scaffold(self, spec_id="spec-one", app="greeter"):
        return factory_scaffold.scaffold(
            app_name=app, spec_id=spec_id, blueprint="microservice", port=3000)

    def test_it_writes_a_repository_with_a_commit(self):
        result = self.scaffold()
        self.assertFalse(result["already_scaffolded"])
        self.assertTrue(len(result["commit"]) == 40)
        self.assertIn("server.js", result["files"])
        self.assertTrue(factory_scaffold.repo_path("greeter").exists())

    # THE BUG this was written for. A retry died at the first step every time,
    # so one transient failure later in the run made the whole spec unrunnable.
    def test_the_same_spec_scaffolding_again_is_not_a_failure(self):
        first = self.scaffold()
        again = self.scaffold()

        self.assertTrue(again["already_scaffolded"])
        self.assertEqual(again["commit"], first["commit"],
                         "a retry must not rewrite the history")

    # Catches: a second deployment overwriting the first one's source. Idempotent
    # for its owner is not the same as open to everybody.
    def test_another_spec_may_not_take_over_the_repository(self):
        self.scaffold(spec_id="spec-one")
        with self.assertRaises(FileExistsError) as caught:
            self.scaffold(spec_id="spec-two")
        self.assertIn("spec-one", str(caught.exception))

    def test_a_different_app_gets_its_own_repository(self):
        self.scaffold(app="greeter")
        other = self.scaffold(spec_id="spec-two", app="counter")
        self.assertFalse(other["already_scaffolded"])

    # Catches: an image tag that two specs from one blueprint would share, so a
    # second build replaces what the first deployed. The tag is the commit the
    # image was built from.
    def test_the_tag_names_the_blueprint_the_app_and_the_commit(self):
        self.assertEqual(
            factory_scaffold.image_tag("microservice", "greeter", "0123456789abcdef"),
            "microservice/greeter:0123456789ab")

    # Catches: building something that was never scaffolded, which would fail
    # inside docker with a message about a missing path rather than here.
    def test_building_what_was_never_scaffolded_says_so(self):
        with self.assertRaises(FileNotFoundError):
            factory_scaffold.build(blueprint="microservice", app_name="absent")


if __name__ == "__main__":
    unittest.main()
