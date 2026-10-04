# Each test names the mistake it catches, because a policy nobody can break is
# a policy nobody has tested.
#
# `with data.x as` replaces one path. Replacing the whole of `data` would also
# replace the policy and these tests, which the compiler reads as recursion.

package factory_test

import rego.v1

import data.factory

spec := {
	"id": "spec-0001",
	"team": "payments",
	"boundaries": {
		"allowed_actions": ["deploy", "promote"],
		"environments": ["staging", "production"],
	},
	"sequence": [
		{"id": "deploy_staging", "action": "deploy", "environment": "staging", "needs": []},
		{
			"id": "sign_off",
			"gate": "promotion_approval",
			"approver_role": "release-manager",
			"needs": ["deploy_staging"],
		},
		{
			"id": "promote_production",
			"action": "promote",
			"environment": "production",
			"needs": ["sign_off"],
		},
	],
}

# The same operation, forked: two checks run at once and the gate joins them.
# Written with the gate LAST, so a rule that read position rather than
# dependencies would find no gate before the promotion and allow it.
forked := {
	"id": "spec-fork",
	"team": "payments",
	"boundaries": {
		"allowed_actions": ["deploy", "verify", "promote"],
		"environments": ["staging", "production"],
	},
	"sequence": [
		{"id": "deploy_staging", "action": "deploy", "environment": "staging", "needs": []},
		{"id": "scan", "action": "verify", "environment": "staging", "needs": ["deploy_staging"]},
		{"id": "load_test", "action": "verify", "environment": "staging", "needs": ["deploy_staging"]},
		{
			"id": "promote_production",
			"action": "promote",
			"environment": "production",
			"needs": ["sign_off"],
		},
		{
			"id": "sign_off",
			"gate": "promotion_approval",
			"approver_role": "release-manager",
			"needs": ["scan", "load_test"],
		},
	],
}

specs := {"spec-0001": spec}

alice := {"id": "alice@acme.com", "type": "person", "roles": ["release-manager"]}

bob := {"id": "bob@acme.com", "type": "person", "roles": []}

worker := {"id": "airflow-worker", "type": "agent"}

approved := {"spec-0001": {"promotion_approval": {"state": "approved", "decided_by": "alice@acme.com"}}}

pending := {"spec-0001": {"promotion_approval": {"state": "pending"}}}

promote_request := {
	"spec_id": "spec-0001",
	"action": "promote",
	"environment": "production",
	"principal": worker,
}

# Catches: an empty engine answering deny with confidence. Nothing is loaded, so
# the honest answer is that it cannot tell, not that the action is refused.
test_no_facts_loaded_is_cannot_tell if {
	result := factory.decision with input as promote_request
		with data.specs as specs
		with data.approvals as pending
	result.result == "cannot_tell"
	contains(result.reason, "not been loaded")
}

# Catches: an unknown spec being treated as permission.
test_unknown_spec_is_cannot_tell if {
	result := factory.decision with input as object.union(promote_request, {"spec_id": "spec-9999"})
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "cannot_tell"
	contains(result.reason, "no record of this deployment spec")
}

# THE HOLE. A run triggered directly at the second stage promotes to production
# with nobody having approved. Sequencing never stopped this; the policy does.
test_promote_without_an_approval_is_denied if {
	result := factory.decision with input as promote_request
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "deny"
	contains(result.reason, "gate promotion_approval has not been approved")
}

# Catches: the gate being ignored once it exists at all, approved or not.
test_promote_with_an_approval_is_allowed if {
	result := factory.decision with input as promote_request
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as approved
	result.result == "allow"
}

# Catches: requiring an approval for a step that has no gate before it, which
# would deadlock the first deploy.
test_first_deploy_needs_no_approval if {
	result := factory.decision with input as object.union(promote_request, {"action": "deploy", "environment": "staging"})
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as {}
	result.result == "allow"
}

# Catches: an action the spec never declared being carried out anyway.
test_an_undeclared_action_is_denied if {
	result := factory.decision with input as object.union(promote_request, {"action": "delete", "environment": "staging"})
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as {}
	result.result == "deny"
	contains(result.reason, "delete is not an allowed action")
}

# Catches: reaching an environment the spec never named.
test_an_undeclared_environment_is_denied if {
	result := factory.decision with input as object.union(promote_request, {"action": "deploy", "environment": "dr"})
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as {}
	result.result == "deny"
	contains(result.reason, "dr is not an allowed environment")
}

# Catches: an absent boundaries block reading as "no limits" instead of "no
# permission". Deny by default has to mean the absence of a rule denies.
test_a_spec_with_no_boundaries_permits_nothing if {
	result := factory.decision with input as object.union(promote_request, {"action": "deploy", "environment": "staging"})
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as {"spec-0001": object.remove(spec, ["boundaries"])}
		with data.approvals as {}
	result.result == "deny"
	contains(result.reason, "not an allowed action")
}

# Catches: anyone signed in passing a gate that named a role.
test_approving_requires_the_role_the_gate_named if {
	result := factory.decision with input as {"spec_id": "spec-0001", "action": "approve", "gate": "promotion_approval", "principal": bob}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "deny"
	contains(result.reason, "requires release-manager")
}

test_the_named_role_may_approve if {
	result := factory.decision with input as {"spec_id": "spec-0001", "action": "approve", "gate": "promotion_approval", "principal": alice}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "allow"
}

# Catches: the agent approving its own gate and promoting itself.
test_an_agent_may_not_approve if {
	agent := {"id": "airflow-worker", "type": "agent", "roles": ["release-manager"]}
	result := factory.decision with input as {"spec_id": "spec-0001", "action": "approve", "gate": "promotion_approval", "principal": agent}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "deny"
	contains(result.reason, "only a person may approve")
}

# Catches: approving a gate the blueprint never declared, which would record an
# approval that releases nothing and reads as governance.
test_an_undeclared_gate_cannot_be_approved if {
	result := factory.decision with input as {"spec_id": "spec-0001", "action": "approve", "gate": "invented_gate", "principal": alice}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as pending
	result.result == "deny"
	contains(result.reason, "not a gate this spec declares")
}

# Catches: a second approval overwriting the first. The store refuses it; the
# policy says why before the write is attempted.
test_a_settled_gate_cannot_be_approved_again if {
	result := factory.decision with input as {"spec_id": "spec-0001", "action": "approve", "gate": "promotion_approval", "principal": alice}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as specs
		with data.approvals as approved
	result.result == "deny"
	contains(result.reason, "already approved")
}

# ------------------------------------------------------- dependencies, not order

# THE REGRESSION. The gate is written after the promotion in this document, so a
# rule that asked "is there a gate earlier in the list" would find none and allow
# an unapproved promotion. Dependencies say otherwise: promote needs sign_off.
test_a_gate_reached_through_needs_is_enforced_whatever_the_order if {
	result := factory.decision with input as promote_request
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as {"spec-0001": forked}
		with data.approvals as {"spec-0001": {"promotion_approval": {"state": "pending"}}}
	result.result == "deny"
	contains(result.reason, "gate promotion_approval has not been approved")
}

test_the_forked_promotion_is_allowed_once_approved if {
	result := factory.decision with input as promote_request
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as {"spec-0001": forked}
		with data.approvals as approved
	result.result == "allow"
}

# Catches: a gate that nothing waits for being treated as blocking. A step that
# does not depend on a gate is not held by it.
test_a_gate_on_another_branch_does_not_block if {
	branched := object.union(forked, {"sequence": [
		{"id": "deploy_staging", "action": "deploy", "environment": "staging", "needs": []},
		{
			"id": "unrelated_gate",
			"gate": "security_review",
			"approver_role": "security",
			"needs": ["deploy_staging"],
		},
		{
			"id": "promote_production",
			"action": "promote",
			"environment": "production",
			"needs": ["deploy_staging"],
		},
	]})

	result := factory.decision with input as promote_request
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as {"spec-0001": branched}
		with data.approvals as {"spec-0001": {}}
	result.result == "allow"
}

# Catches: the first step of a fork being held by a gate that comes after it.
test_a_step_before_the_gate_is_not_held_by_it if {
	result := factory.decision with input as {
		"spec_id": "spec-0001",
		"action": "verify",
		"environment": "staging",
		"principal": worker,
	}
		with data.loaded_at as "2026-09-28T00:00:00Z"
		with data.specs as {"spec-0001": forked}
		with data.approvals as {"spec-0001": {"promotion_approval": {"state": "pending"}}}
	result.result == "allow"
}
