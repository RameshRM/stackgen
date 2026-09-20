"""Runs both questions. Mirrors stackgen/js/solution.js."""

import json

from . import loader, question_a, question_b

query_defaults = loader.query_defaults()


def main():
    return {
        "solnA": question_a.answer(
            query_defaults["tenant_id"],
            query_defaults["environment"]),
        "solnB": question_b.answer(
            query_defaults["tenant_id"],
            query_defaults["environment"],
            query_defaults["application_name"]),
    }


result = main()
print(json.dumps(result, indent=2))
