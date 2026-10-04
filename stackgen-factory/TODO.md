# Open work

## Observability belongs in its own DAG

It is a task inside every deployment's DAG today, which puts two assumptions in
the deploy path: that the target is Kubernetes, and that the way to observe it is
a Prometheus scrape. Neither is the deploy's business.

It should be one scheduled DAG that reconciles across every deployment spec:
ensure whatever collects evidence exists, install an alert rule per spec from its
blueprint's acceptance block, and remove rules for specs that are gone. A spec
that arrives between runs is picked up on the next one, and a spec deleted by
hand stops having rules without anybody remembering to clean up.

That also removes the ordering problem the current shape has — provisioning has
to come after the pods exist, so it sits between deploy and gate and lengthens
every run.

## Move protocol out of `workload`

`workload` should be the resource envelope the platform governs — replicas, cpu,
memory — and nothing about how an application is spoken to. Today it also holds
`port`, `health_path` and `metrics_path`, which are properties of the
application, not of the governance.

They become questions with defaults, so a blueprint for something that serves no
HTTP simply does not ask them:

    questions:
      - id: port
        type: number
        default: 3000
      - id: health_path
        type: string
        default: /health
      - id: metrics_path
        type: string
        default: /metrics

The generator then emits a container port, a readiness probe and a scrape
annotation only when there is an answer — not because a `kind` flag said so.
That removes the need for a `kind` enum and the second place it would describe
the same fact.

Why it matters now: a blueprint with no `port` publishes cleanly and generates
`containerPort: {}`, `PORT=undefined`, `readinessProbe: {httpGet: {}}` and
`prometheus.io/port: "undefined"`. The validator does not object.

Touches: `kustomize.js`, `resolve.js`, `blueprint.js` (stop requiring the HTTP
fields), `blueprints/deploy-service.yaml` (move three fields, version bump),
`kustomize.test.js` (asserts port and probe from workload today).

Consequence to keep in view: a developer could then set `metrics_path` to
something that returns nothing, and acceptance would read `cannot_tell`. It
fails safe, but it is a self-service knob that can break your own acceptance.

## Identity is a plaintext header

`x-factory-user: dana@acme.com` makes you platform-admin. Every role check sits
on it, including the policy's `only a person may approve`. The mock OIDC
provider plus `jose` was laid out and deferred; until it lands, no role
boundary in this system is enforced.

## Acceptance data is not durable

Prometheus stores to an `emptyDir` with two hours of retention. Fine for a
demonstration, wrong for anything that has to answer a question about last week.

## Published blueprints are not in git

Publishing writes `blueprints/<name>.yaml` and records the row. The file is
untracked until somebody commits it, so the store is the record and the
repository is a copy. Deliberate, and worth revisiting if governance is meant to
be reviewed.

## Stale documents

`IMPLEMENTATION.md` predates the store, the policy engine, the dynamic DAGs and
the authoring UI. It misleads rather than informs.

`ui/dist/` is committed build output that nothing serves.

`var/` (the store, its WAL, `opa.log`) is generated and not in `.gitignore`.
`approvals/` and `audit/` still hold the files the store replaced.
