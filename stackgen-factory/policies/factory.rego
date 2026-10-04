# What may happen, and who may say so.
#
# The control plane records this policy and the facts it reads. A caller sends
# only what it intends to do and who it claims to be; it never sends the evidence
# that would justify it. That is the point: an Airflow worker asking whether it
# may promote cannot also assert that the promotion was approved.
#
# Three outcomes, kept distinct:
#
#   allow        the rules permit it
#   deny         the rules refuse it
#   cannot_tell  the evidence needed to judge is missing
#
# cannot_tell is not allow. A caller must treat it as a refusal, but it is a
# different fact in the audit: "we said no" and "we could not tell" are not the
# same sentence, and collapsing them is how a control plane starts lying.

package factory

import rego.v1

spec := data.specs[input.spec_id]

# Deny by default, and refuse to guess. An absent spec is not permission.
default decision := {
	"result": "cannot_tell",
	"reason": "the policy engine holds no record of this deployment spec",
}

# The engine holds rules but no facts yet. Every gate would look unapproved and
# every answer would be a confident deny, which would be a lie.
decision := {
	"result": "cannot_tell",
	"reason": "the store has not been loaded into the policy engine",
} if {
	not data.loaded_at
}

decision := {"result": "deny", "reason": concat("; ", sort(denials))} if {
	data.loaded_at
	spec
	count(denials) > 0
}

decision := {"result": "allow", "reason": granted} if {
	data.loaded_at
	spec
	count(denials) == 0
}

# ---------------------------------------------------------------- workload acts

# An absent boundaries block permits nothing, rather than everything.
denials contains msg if {
	is_workload_action
	not input.action in object.get(spec, ["boundaries", "allowed_actions"], [])
	msg := sprintf("%s is not an allowed action for this spec", [input.action])
}

denials contains msg if {
	is_workload_action
	not input.environment in object.get(spec, ["boundaries", "environments"], [])
	msg := sprintf("%s is not an allowed environment for this spec", [input.environment])
}

# The rule the sequencing alone never enforced: a gate declared before this
# action must be approved before the action may happen. Without this, a run
# triggered straight at the second stage promotes to production unapproved.
denials contains msg if {
	is_workload_action
	some gate in preceding_gates
	not gate_approved(gate)
	msg := sprintf("gate %s has not been approved", [gate])
}

# ----------------------------------------------------------------- approving it

# Roles are asserted by the caller, so this rule is only as good as the caller's
# identity. The control plane takes them from a verified token and is the only
# thing that should be able to reach this with action "approve"; an agent
# claiming to be a person is a hole that closes at the network, not here.
denials contains msg if {
	input.action == "approve"
	input.principal.type != "person"
	msg := sprintf("only a person may approve, and this principal's type is %s", [input.principal.type])
}

denials contains msg if {
	input.action == "approve"
	required := gate_role
	required != ""
	not required in object.get(input, ["principal", "roles"], [])
	msg := sprintf("approving %s requires %s", [input.gate, required])
}

denials contains msg if {
	input.action == "approve"
	not declared_gate
	msg := sprintf("%s is not a gate this spec declares", [input.gate])
}

# A gate already settled is not open to a second decision. The store refuses
# this too; saying it here means the caller is told why rather than finding out
# by changing no rows.
denials contains msg if {
	input.action == "approve"
	state := data.approvals[input.spec_id][input.gate].state
	state != "pending"
	msg := sprintf("gate %s is already %s", [input.gate, state])
}

# ----------------------------------------------------------------------- helpers

is_workload_action if {
	input.action != "approve"
}

# Every gate appearing earlier in the sequence than the step being attempted.
# ------------------------------------------------- what must happen first

# The step being attempted. A sequence can fork, so more than one step may share
# an action and an environment; each is judged on its own dependencies.
attempted contains step_id if {
	some step in spec.sequence
	step.action == input.action
	step.environment == input.environment
	step_id := step.id
}

steps_by_id[step.id] := step if {
	some step in spec.sequence
}

# Everything a step waits for, directly or through another step.
#
# This walks `needs`, not position. A sequence used to be a list where every step
# followed the one written above it, and the rule read `j < i` — which was right
# only while a sequence could not fork. It can now: two steps may be written in
# either order and depend on neither, and a gate written above a step is not
# necessarily a gate that step waits for. Reading position would check the wrong
# gates, and would start checking them the moment somebody reordered the
# document without changing what it means.
reaches(from) := {id |
	some id in graph.reachable(needs_graph, {from})
}

needs_graph[id] := needs if {
	some step in spec.sequence
	id := step.id
	needs := {n | some n in object.get(step, "needs", [])}
}

preceding_gates contains gate if {
	some step_id in attempted
	some upstream in reaches(step_id)
	gate := steps_by_id[upstream].gate
}

gate_approved(gate) if {
	data.approvals[input.spec_id][gate].state == "approved"
}

declared_gate if {
	some step in spec.sequence
	step.gate == input.gate
}

gate_role := role if {
	some step in spec.sequence
	step.gate == input.gate
	role := object.get(step, "approver_role", "")
}

granted := sprintf("%s holds %s for gate %s", [input.principal.id, gate_role, input.gate]) if {
	input.action == "approve"
}

granted := sprintf(
	"%s to %s is within the spec's boundaries and every preceding gate is approved",
	[input.action, input.environment],
) if {
	is_workload_action
}
