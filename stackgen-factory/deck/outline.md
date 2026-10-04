# Autonomous Operations Factory — deck outline

Working prototype. Each design slide: **Decision · Why · Rejected · Code**.

---

## 1. Title
- Autonomous Operations Factory
- Working prototype

## 2. The pipeline

```
Blueprint ──resolve──▶ Deployment Spec  (answers only)
 (platform admin)      (developer's answers)
                              │
                              ▼
                        DAG (Airflow)
   scaffold → build ──▶ image, tagged with its commit
                 │
                 ▼  control plane generates the kustomize tree, naming that image
   deploy_staging ──▶ render staging overlay → kubectl apply
         → checks → sign_off
   promote_production ──▶ render production overlay → kubectl apply
```

| Artifact | Written by | When |
|---|---|---|
| Blueprint | platform admin | publish |
| Deployment Spec | control plane, from the developer's answers | submission |
| DAG | DAG factory, from the spec in the store | Airflow parse |
| Image | `build` task | after scaffold |
| kustomize tree | control plane, asked by the `build` task | after build |

- **Why after build:** a tree for an image that was never built is a record of a deployment that cannot happen
- **How:** `build` calls `POST /api/deployments/:id/manifests` with its image; a blueprint with no build calls it before the first deploy, with the answered image

## 3. Blueprint
- **Decision:** one document holds the governance and the workload envelope
- Governance: questions, boundaries, sequence, gate, record, acceptance
- Workload: replicas, cpu, memory per environment
- **Why:** an operation is governed in one place, authored once
- Refused at publish if the sequence cannot run: a cycle, or a `needs` that points nowhere
- **Code:** `control-plane/src/blueprint.js`, `sequence.js`

## 4. Deployment Spec
- **Decision:** blueprint + answers, resolved into one document; the image is added after build
- `type` selects the target; `k8s` is the one implemented
- Writing the spec submits it; there is no run button, and the submission is audited
- **Why:** declaring the desired state is the instruction to converge on it
- **Code:** `control-plane/src/resolve.js`, `submit.js`

## 5. Spec → DAG
- **Decision:** one DAG per spec, holding the whole sequence
- A DAG factory reads every spec from the store; nothing is written into the dags folder
- The sequence is a graph (`needs`), so steps can fork and join
- **Rejected:** one DAG per gate. A sensor in reschedule mode already frees its worker while it waits; splitting lost the end-to-end graph
- **Code:** `control-plane/src/dag.js`, `orchestrator/dags/factory_dags.py`

## 6. DAG tasks

| Task | Does |
|---|---|
| scaffold | creates a git repo holding a working Node service |
| build | builds it into an image, loads it into the cluster |
| (in build) | asks the control plane for the kustomize tree, naming the built image |
| deploy_staging | renders the staging overlay and applies it |
| observe / checks | makes the deployment measurable, then evaluates acceptance |
| sign_off | sensor; waits for a person with the gate's role |
| promote_production | renders the production overlay and applies it |

- **Decision:** manifests are generated after build, naming the image that was actually built
- **Rejected:** generating at submission with a pre-named `:latest` tag (the earlier version); a failed build left manifests for an image that did not exist
- **Code:** `orchestrator/dags/factory.py`, `factory_scaffold.py`, `factory_manifests.py`, `control-plane/src/manifests.js`

## 7. Target: k8s + kustomize
- **Decision:** the target is an option on the spec (`type`), not the model; k8s is the first
- The orchestrator refuses a target it cannot realise
- **Why k8s first:** a real deployment, so acceptance is measured against something running
- **Why kustomize:**
  - one overlay per blueprint environment (staging, production)
  - the kustomization is the editable artifact; a rendered manifest would be raw YAML
  - the tree belongs to one spec: no shared file to edit between build and apply
- Example, `spec-dae7acb0`:
  - base: replicas 1, cpu 50m/200m, memory 64Mi/128Mi
  - production overlay: replicas 2, cpu 200m/1000m, memory 256Mi/512Mi
- **Code:** `control-plane/src/kustomize.js`, `resolve.js:14`, `factory.py:144`

## 8. Policy at every action
- **Decision:** the worker decides nothing; it states intent and asks OPA
- Outcomes: `allow` · `deny` · `cannot_tell` (refuses, recorded differently)
- The caller sends intent and identity, never the evidence; facts come from the store
- A run posted straight at promote is refused: no approval on record
- RBAC is one input; boundaries, team and gate state are the others
- **Code:** `policies/factory.rego`, `factory.py: request_action`

## 9. Identity
- **Decision:** signed JWT, verified against the issuer's key set
- The issuer sets `principal_type`: client_credentials → agent, sign-in → person
- Team and roles come from the token, never from a body, query or header
- **Code:** `control-plane/src/principal.js`, `identity/`

## 10. Acceptance
- **Decision:** the app exposes raw counters; the factory judges
- Prometheus scrapes `/metrics`; one alert rule per spec, from the blueprint's acceptance block
- **Why:** an app that graded itself could report whatever it liked
- **Code:** `orchestrator/dags/factory_metrics.py`

## 11. Demo
- `whoami` → `agent:developer:payments`
- `deployment_create { blueprint: foo, answers: { app_name: bar } }` → `spec-<id>`
- At submission: `deployments/<id>/spec.yaml` only
- After build:
  - `kustomize/base/{deployment,service,kustomization}.yaml`
  - `kustomize/overlays/{staging,production}/kustomization.yaml`
- DAG `spec_<id>` in Airflow

## 12. Prototype limits

| Prototype | Production |
|---|---|
| SQLite store | Managed DB |
| Mock OIDC issuer | Real IdP |
| Prometheus on emptyDir, 2 h retention | Durable metrics backend |
| kind, one cluster | Real clusters |
| One target type (k8s) | Further targets per `type` |
| Image tagged with its commit, loaded into kind | Registry, pinned by digest |
| Manifests endpoint unauthenticated (OPEN) | Run-scoped token, checked by policy |
