# Autonomous Operations Factory — implementation plan

Instructions for building this. Decisions are settled; do not re-litigate them.
Where something is genuinely open it says **OPEN**.

Scope for now is the **happy path**. Rejections, rollback and error recovery are
deliberately deferred — see *Deferred* at the end.

## Local prerequisites

```
kind            the deployment target
kubectl         applies the converted spec
opa             policy decisions
airflow         orchestration
node            control plane, demo app, ui
```

No `terraform` binary. Terraform is a *shape* we borrow for declaring desired
state, not a tool in the path — see *How the WISB reaches the cluster*.

One `kind` cluster, two namespaces: `staging` and `production`.

## What we are building

A control plane where a platform admin authors governed blueprints, developers
self-serve against them, agents execute the work, and humans approve only where
the blueprint says to.

The differentiator is **the point where an agent is told no**. Authoring,
workflow execution and desired-state declaration are all commodity. The
enforcement boundary is not.

## Vocabulary

| Term | Meaning |
|---|---|
| Blueprint | A **spec**. The reusable, governed template: boundaries, sequence, gates, record, acceptance. Holds `{{ placeholders }}`, never instance values. Version governed. |
| Instance spec | The **WISB** — the desired state of one application deployment. Blueprint version + the developer's answers + the image digest. Immutable. |
| Run | One execution of an instance spec. A durable entity with state, not a function call. |
| Gate | A declared stop where an authorized principal must approve. |
| Principal | A person or an agent. Both are authenticated and authorized. |
| Agent | An untrusted client of the control plane API. It refers to the blueprint and follows the DAG. It has no latitude and chooses nothing. |
| Broker | Holds credentials. Acts only on an `allow` from the policy engine. |

WISB is the desired state of an *application*, not a property of a blueprint.
The blueprint is the template; resolving it produces a WISB.

## Two documents, not one

A blueprint is reusable, so it cannot hold anything specific to one deployment.
Resolution happens at submission.

```
blueprint          blueprints/deploy-microservice.yaml, version 3
                   {{ placeholders }}, no image, no answers
                   one blueprint, many deployments

instance spec      instances/run-4271.yaml
                   blueprint version + answers + image digest
                   immutable once created
                   the WISB of this deployment
```

```yaml
# instances/run-4271.yaml
blueprint: deploy-microservice
blueprint_version: 3
team: payments
answers:
  stack: node
  slo_error_rate: 0.01
image: ghcr.io/acme/payments-api@sha256:a1b2c3...
created_at: 2026-09-28T10:04:00Z
```

Same split as everywhere else: Helm chart to release, Terraform module to state,
Deployment to Pod.

| | |
|---|---|
| Airflow executes | the instance spec, never the blueprint |
| audit references | the instance spec, plus the blueprint version it came from |
| a blueprint version change | produces a new instance spec, which re-triggers the run |
| the image digest | lives only in the instance spec |

An instance spec is immutable. Re-running against a new blueprint version creates
a new one rather than editing the old, so the audit trail keeps what was actually
deployed at each point.

## Multi-tenancy

Every blueprint and every run belongs to a team. This is one field and one
check — do not build an org model.

```yaml
# in a blueprint
owner_team: platform
visibility: shared          # shared | team

# in an instance spec
team: payments              # who submitted it
```

Rules:

```
a blueprint with visibility: shared    any team may submit against it
a blueprint with visibility: team      only owner_team may submit
a run                                  visible to its team, plus platform-admin
```

`team` is part of the policy input, so isolation is enforced at the same decision
point as everything else rather than by filtering in the UI. A query for another
team's run returns not-found, not forbidden — the existence of the run is itself
scoped.

Treat the team on a validated JWT as trusted context. Do not accept a team from
a request body.

## Storage — files, no database

Everything persists as files on disk. No database, no repository layer.

```
blueprints/deploy-microservice.yaml   the spec, version controlled
instances/run-4271.yaml               the WISB, written once
runs/run-4271.json                    run state, rewritten on change
audit/run-4271.jsonl                  append only, one decision per line
```

**Why this is safe: the control plane is the single writer.** Every action goes
through `POST /runs/:id/actions`, and Airflow calls that endpoint rather than
touching state itself. Two processes never write the same file. If Airflow wrote
run state directly you would have a race — which is the same back door already
ruled out for other reasons.

It also makes the demo legible. A reviewer can `cat audit/run-4271.jsonl` and read
every decision in order, without a query.

`sqlite` stays where it is, inside the demo app, for the app's own data.

## Components

```
stackgen-factory/
  blueprints/          reusable specs, version controlled
  instances/           resolved instance specs, one per deployment
  control-plane/       Node.js API — blueprints, runs, approvals, audit
  policy/              OPA policies + tests
  orchestrator/        Airflow DAGs
  ui/                  single page app
  demo-app/            GraphQL + Express + sqlite, the thing being deployed
  scaffolds/           two stack templates, no more
  specs/               WISB resource declarations, Terraform-shaped
  kind/                local cluster config, the demo deployment target
  runs/                run state, one JSON file per run
  audit/               append-only decision log, one JSONL file per run
```

### blueprints/

One YAML file per blueprint. A version change re-triggers orchestration, so git
is the reconciliation trigger and every convergence traces to a commit.

The six governance keys come straight from the demo. `spec` on a step is our
addition, since the demo never says how the work is done.

```yaml
name: deploy-microservice
version: 3
owner_team: platform
visibility: shared

# asked at execution time, answers supplied by the developer
questions:
  - id: stack
    type: enum
    values: [node, java]
  - id: slo_error_rate
    type: number
    default: 0.01

# what this operation may do, at all
boundaries:
  allowed_actions: [deploy, promote]
  environments: [staging, production]
  allowed_resources: [kubernetes_deployment, kubernetes_service]

# the ordered path, including where humans are involved
sequence:
  - action: deploy
    environment: staging
    spec: ./specs/microservice.yaml
    vars:
      image: "{{ image_digest }}"
      replicas: 3

  - gate: promotion_approval
    approver_role: release-manager

  - action: promote
    environment: production
    spec: ./specs/microservice.yaml
    vars:
      image: "{{ image_digest }}"
      replicas: 6

# what must be captured as the run proceeds
record:
  - image_digest
  - approver
  - error_rate_at_promotion
  - resolved_spec_digest

# what must verify before the deployment counts as successful
acceptance:
  - id: error_rate
    source: metrics
    expression: error_rate < {{ slo_error_rate }}
    window: 10m
```

**The split, and why.** Governance and declaration are separate files.

```
governance   gates · approvals · acceptance · boundaries · record
declaration  resource types and their attributes
```

Two files, two jobs. The blueprint says how an operation is governed and never
names a container port. The spec declares desired resources and never mentions a
release manager.

`{{ image_digest }}` and `{{ slo_error_rate }}` are placeholders, resolved into
the instance spec at submission.

`boundaries.allowed_resources` matters: it is what stops a step declaring a
resource type the admin never approved. A type outside that list is
`deny: outside_boundary`, same as any other action.

**Where the blueprint is read** — six points. Do not consume and discard it after
run creation:

1. submission — which questions to ask
2. workflow build — the step sequence
3. every action — boundaries, for the policy check
4. each gate — who may approve it
5. acceptance — what must pass
6. after deploy — its acceptance criteria, evaluated against what observability
   reports

Point 6 is not a spec-to-spec comparison. The instance spec declares what should
be true; observability reports what is; you compare those.

### instances/

Written once at submission, never edited. For the demo, files on disk plus a row
in the control plane's store. The file is the artifact a reviewer can read; the
row is what the API serves.

### control-plane/

Node.js API. Holds blueprints, run state, approvals, audit. The SPA talks to this
and nothing else.

Responsibilities:

- parse and validate blueprints
- resolve a blueprint plus answers into an instance spec
- create runs and hold run state
- issue a policy decision request for **every** action
- record every decision with its reason
- scrape the deployed app's `/metrics` and evaluate acceptance
- expose the audit trail

Minimum run record — enough for the policy check to answer *may this action
happen now?*

```json
{
  "run_id": "4271",
  "team": "payments",
  "instance_spec": "instances/run-4271.yaml",
  "blueprint": "deploy-microservice",
  "blueprint_version": 3,
  "current_step": 1,
  "gates_passed": [],
  "approvals": []
}
```

Audit record — one row per decision, append only:

```json
{
  "run_id": "4271",
  "at": "2026-09-28T10:07:12Z",
  "principal": { "id": "agent-7", "type": "agent" },
  "action": "promote",
  "target": { "environment": "production" },
  "decision": "deny",
  "reason": "gate_not_passed",
  "blueprint_version": 3
}
```

Run state must survive a restart. Airflow only executes between states; the
approval state is the system of record.

**Every action goes through one endpoint:**

```
POST /runs/:id/actions        { action, target }
  → authn      who is calling, from the JWT
  → authz      may they, given this run's state
  → allow      broker executes, result recorded
  → deny       403, recorded with its reason
```

The orchestrator calls the same endpoint as everyone else. **No privileged back
door for Airflow** — otherwise the boundary has a hole shaped exactly like our
own infrastructure.

**Version-change trigger.** For the demo, an explicit `POST /blueprints/reload`
re-reads the directory and creates a new instance spec for affected runs. A git
webhook is the production shape; say so, do not build it.

### policy/

OPA. One decision point. Every action passes authn then authz — agents, humans,
and the orchestrator. No exceptions.

Input:

```json
{
  "principal": { "id": "agent-7", "type": "agent", "team": "payments",
                 "roles": ["deployer"] },
  "action": "promote",
  "target": { "environment": "production" },
  "blueprint": { "boundaries": {}, "sequence": [] },
  "run": { "team": "payments", "current_step": 1,
           "gates_passed": [], "approvals": [] }
}
```

Output: `allow`, or `deny` with a reason. Both are recorded.

The JWT proves identity and static capability. The policy check supplies run
context — this is why the check happens at runtime rather than by minting a fresh
token per step. `promote` can be in `allowed_actions` and still be denied as
`gate_not_passed`.

Cases that must work:

```
deploy to staging       step 1, no gate needed          allow
promote to production   no approval yet                 deny: gate_not_passed
promote to production   approved by a release-manager    allow
resize RDS              not in allowed_actions           deny: outside_boundary
resource not in list    outside allowed_resources        deny: outside_boundary
run owned by team B     caller is team A                 deny: not_found
```

**The agent must not hold a raw credential.** It asks the broker; the broker
checks policy and acts. Otherwise the policy check is advisory and the agent does
whatever it decides.

**Denials are evidence.** A recorded `deny: gate_not_passed` proves the rails
held, rather than merely that nothing bad happened.

Because the agent follows the DAG and has no latitude, a correct run never
produces a denial. The boundary is a safety net, so it has to be demonstrated
deliberately — see *The demo*.

### identity/

One IdP, Keycloak-style, two principal types:

```
person   OIDC login, user in a realm, carries team and roles
agent    service account, run-scoped short-lived token
```

- A gate names the role that may pass it. The approver is checked against the
  blueprint, not against repo access.
- An approval is a privileged act. Step-up re-auth at the gate.
- **No delegation after approval.** The agent acts as itself once policy sees
  `gate_passed`. The audit keeps two separate facts — "agent promoted" and
  "Alice approved at 14:32" — rather than the agent borrowing Alice's identity.
- `team` comes from the validated token, never from a request body.

### orchestrator/

Airflow. Chosen for being open source and extensible.

**A human gate does not block a DAG.** The DAG creates an approval task and
finishes. The task pends outside Airflow. On approve, a new DAG run resumes from
that point. No sensor, no held worker slot.

```
DAG-1   deploy to staging → evaluate acceptance → create approval task → finish
                                                            |
                                                  pending (control plane)
                                                            |
                          approved → trigger DAG-2 → promote to production
```

The deploy step posts the action to the control plane, which converts the
resolved spec to a Kubernetes manifest and applies it to the target namespace in
the local `kind` cluster.

A Kubernetes deploy is one step among others, not the model. Do not assume k8s is
the substrate: the spec declares resources provider-neutrally and a converter
targets Kubernetes, so a second converter reaches a different cloud. This is why
we are not using Crossplane.

### ui/

Single page app, the demo surface for the whole flow.

```
essential   runs        list, and one run live with its steps
            approvals   pending gates and pending decisions
            audit       every decision with its reason
thin        blueprints  list and the spec itself
            submit      form generated from the blueprint's questions
```

Build the essential three properly. The story is a run mid-flight, stopped at a
gate, with a trail showing the rails held.

GitHub Actions required reviewers is a second approval channel. **Neither channel
decides.** Both emit the same approval event into the same policy check, or you
have two doors with different locks and the GitHub one is weaker.

### demo-app/

GraphQL + Express + sqlite. What the blueprint actually deploys.

Must expose:

```
/health           liveness
/metrics          Prometheus format, raw counters
```

```
http_requests_total{status="200"} 9840
http_requests_total{status="500"} 41
```

**The control plane does the arithmetic**, against the criterion in the
blueprint. The app publishes evidence; it does not grade its own homework. An app
that self-reported a verdict could report whatever it liked, and every new app
would reimplement the logic.

**The app must be able to fail acceptance on demand** — an env var that returns
500s or inflates latency, and a way to make `/metrics` unreachable. A deploy that
always passes proves nothing.

### specs/

Resource declarations in Terraform's shape — a resource type, a name, a block of
attributes. Our own YAML, not HCL, so nothing parses HCL and no `terraform`
binary is involved.

```yaml
# specs/microservice.yaml
resources:
  - type: kubernetes_deployment
    name: "{{ app_name }}"
    attributes:
      image: "{{ image_digest }}"
      replicas: "{{ replicas }}"
      namespace: "{{ environment }}"

  - type: kubernetes_service
    name: "{{ app_name }}"
    attributes:
      port: 3000
      namespace: "{{ environment }}"
```

We use Terraform's shape because it is a familiar way to declare desired state,
and because keeping the declaration provider-neutral is what leaves the path open
to targets other than Kubernetes. It is a borrowed vocabulary, not a dependency.

### kind/

A local `kind` cluster is the deployment target. It is where the demo app
actually runs, so acceptance is measured against a real deployment rather than a
stub.

```
kind cluster
  namespace staging      → replicas 3
  namespace production   → replicas 6
```

The blueprint's two environments map to two namespaces in the one cluster. That
is enough to make promotion real — a different namespace, a different replica
count, the same image digest.

Metrics are reached by a `Service` plus a port-forward, or a NodePort. The
control plane scrapes `/metrics` through it. Deleting the Service is how you
produce `cannot_tell` in demo beat 8.

Note for the design writeup: **k8s here is the deployment target, not the control
plane substrate.** That distinction is why we still rejected Crossplane — we are
not making Kubernetes the thing that governs everything, only the thing this demo
deploys onto. The spec stays provider-neutral, so the path to another target is a
second converter rather than a rewrite.

### scaffolds/

Two stacks, Node and one other. Two proves the blueprint drives the choice rather
than the code assuming one answer. A third template teaches a reviewer nothing
the second did not.

## How the WISB reaches the cluster

```
instance spec (WISB)          desired state, Terraform-shaped
        |
     converter                resource type → Kubernetes kind
        |
   k8s manifest               Deployment, Service
        |
   kubectl apply              through the broker, after an allow
```

The converter is a small function per resource type. Two types is enough:

```
kubernetes_deployment  → apps/v1 Deployment
kubernetes_service     → v1 Service
```

`boundaries.allowed_resources` is what stops a step declaring a resource type the
admin never approved. A type outside that list is `deny: outside_boundary`, the
same as any other action — a string comparison, no parsing.

**Why a converter rather than `terraform apply`.** The enforcement boundary works
identically either way: the allowlist compares whatever the step references
against what the blueprint permits. Terraform would add a binary, a provider
download and state files without making the boundary any stronger. The
declaration stays provider-neutral, which is the part that matters for reaching
another cloud later.

## Acceptance evaluation

Three outcomes, never two:

```
metrics show 0.4%       pass
metrics show 3%         fail
metrics unreachable     cannot_tell
```

`cannot_tell` is retried across the acceptance window. If it still cannot be
measured, the run holds and surfaces a **`pending_decision`**.

```
gate approval      "the blueprint says a human must approve here"
pending_decision   "we could not measure; you decide"
```

Both need an authorized principal, both are recorded with who decided and why,
and both appear in the approvals view.

Reporting `cannot_tell` as `fail` blocks a good deploy. As `pass`, it promotes
blind.

**Do not build drift detection for anything a control loop already owns.** In
Kubernetes the spec is the source of truth and the apiserver keeps replicas at 3;
comparing there duplicates k8s, worse. Terraform does not continuously reconcile,
but `terraform plan` is already the drift detector. The third state belongs to
acceptance evidence, not to drift.

## The demo

Five minutes. Build toward this; if a phase does not serve it, cut the phase.

| # | Beat | Shows |
|---|---|---|
| 1 | The blueprint, in git | Governance is authored, reviewable, versioned |
| 2 | Developer submits: stack `node`, SLO `1%` | Self-serve. An instance spec appears, with the digest |
| 3 | Run deploys to staging; DAG ends at the gate | The spec is converted and applied, creating the Deployment in `kind`. Long-running work, no held worker |
| 4 | Acceptance passes from real `/metrics` | The criterion is evaluated from evidence, not asserted |
| 5 | `curl` the promote endpoint, skipping the gate | **`deny: gate_not_passed`.** The rails hold against a caller bypassing the orchestrator |
| 6 | Approve as a release-manager; promotion runs | Same digest, production namespace, 6 replicas. The gate names a role and the approver is checked against it |
| 7 | The audit trail | Every decision, who, when, why — including the denial from beat 5 |
| 8 | Re-run against the bad app version | Acceptance fails and promotion is blocked. Then delete the Service: `cannot_tell`, not a false pass |

Beats 5, 7 and 8 are the assignment. The rest is the setup that makes them
legible.

## Build order

Each phase runs end to end before the next begins. Ordered so that there is
always something for the next phase to act on.

| Phase | Deliverable | Done when |
|---|---|---|
| 1 | Blueprint schema + validator | A blueprint that would let a step exceed its boundaries is rejected |
| 2 | Submission → instance spec | Answers plus a digest resolve into an immutable instance spec |
| 3 | Runs + run state | A run exists, survives a restart, exposes `current_step` |
| 4 | Action endpoint + broker | An action executes through the broker and is recorded |
| 5 | Policy decision point | The six cases above return the right verdict, each recorded. Beat 5 of the demo works |
| 6 | Airflow DAG to the gate | The spec is applied to the staging namespace in `kind`, DAG ends, approval task pends |
| 7 | Approval + resume | Approval triggers DAG-2. A non-approver is refused. Beat 6 works |
| 8 | Demo app + acceptance | Pass, fail, and `cannot_tell` all reachable. Beat 8 works |
| 9 | UI: runs, approvals, audit | The whole story is visible in a browser |
| 10 | Scaffolds | Two stacks generate |

Phases 5, 7 and 8 carry the judgement. Phase 4 before 5 is deliberate — you
cannot demonstrate a denial until there is an action to deny. Phase 10 is the
least valuable; cut it first.

## Testing

The policy engine is the differentiator, so it carries the tests.

| Area | Tests |
|---|---|
| Policy | The six cases in `policy/`. OPA has a native test runner — use it |
| Blueprint validator | A resource type outside `allowed_resources`; an action outside `allowed_actions`; a gate naming no role |
| Tenant isolation | Team A cannot read, approve, or act on team B's run |
| Acceptance | `pass`, `fail`, and `cannot_tell` from controlled `/metrics` responses |
| Idempotency | The same instance spec executed twice produces the same decisions |
| Approval authority | A principal without the gate's role is refused |

**Mutation-check the policy tests.** Break one rule at a time — drop the
`gates_passed` check, drop the team comparison, accept any module — and confirm
exactly the expected test fails. A policy suite that still passes with a rule
removed is decoration. This is the same check applied to the previous exercise
and it is the strongest evidence the boundary is real.

## Explicitly not building

| | Why |
|---|---|
| Backstage or Port | A git repo of YAML blueprints is the same front door |
| Crossplane | Makes Kubernetes the substrate for everything |
| Temporal | Narrower ecosystem than Airflow |
| Prometheus | Scraping the app directly has the right shape |
| Drift detection for k8s fields | The apiserver already does it, better |
| A third scaffold template | Adds files, not insight |
| A blueprint authoring UI | The commodity half |
| An org or RBAC model | One `team` field and one check is enough |
| A git webhook | An explicit reload endpoint demonstrates the same trigger |
| `terraform apply` | The allowlist enforces identically without it; a binary, provider and state files add nothing to the boundary |

## Deferred

Named so a reviewer knows it was a choice, not an oversight.

- **Failure path.** What happens when acceptance fails: rollback, alerting,
  partial state. Currently the run stops.
- **Rejection of an approval.** Only approve is wired.
- **Concurrent runs** against the same target.
- **Secret management** beyond the broker holding credentials.
- **Real IaC in the path.** A converter stands in for `terraform apply`; state, drift and locking come with the real thing.

## OPEN

- Which second scaffold stack (Java or Python)
- Whether the broker is a separate service or a library inside the control plane
