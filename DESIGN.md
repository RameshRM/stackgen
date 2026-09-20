# Design note

## How the model is built

The input files plus `EXTRACT_NOTES.md` are the spec. Nothing about their shape
is guessed.

```
input files + EXTRACT_NOTES.md
  -> docs/spec.yaml          written strictly from those files
  -> stackgen/spec_models.py generated from the yaml
  -> stackgen/loader.py      reads the files
  -> question_a.py / question_b.py
```

`docs/spec.yaml` uses the field names exactly as they appear on disk
(`InstanceId`, `providerID`, `DBInstanceArn`). Its descriptions are quoted from
`EXTRACT_NOTES.md`, not written by us. `spec_models.py` is generated and never
hand-edited.

The schema is documentation. The code reads plain dictionaries at runtime.

## What makes two records the same thing

Two records describe the same cloud resource when they agree on
`(tenant_id, account_id, region, native_id)`.

The first three come from the manifest snapshot, never from the record. This
matters: `i-00000000000000101` is supplied under **both** acme and bravo, in the
same AWS account. An ARN does not separate them either — it carries account and
region, but no tenant. Only the manifest does.

Relationships are edges, each with its own evidence:

| Edge | Established by |
|---|---|
| catalog app -> Deployment | the row names `cluster_id`, `namespace`, `deployment_name` |
| Deployment -> ReplicaSet -> Pod | `ownerReferences` uid, not display name |
| Pod -> Node | the Pod states `spec.nodeName` |
| Node -> EC2 | last path segment of `spec.providerID` |
| EC2 -> Terraform | `values.id`, and only when `mode` is `managed` |
| catalog app -> database | declared ARN matched to `DBInstanceArn` |

Every claim carries `stated_by` and a `rule`. `source` means a file says it.
`derived` means our code worked it out. `owner_team = team-payments` is one CSV
cell. "payments-api runs on i-…101" is five hops of inference. The output says
which is which.

Unknowns are first class. Three verdicts, never two:

- `binding_found` — a managed record references it
- `no_binding_found` — the state was searched, nothing manages it
- `evidence_unavailable` — no state was supplied, so nothing was searched

The third comes from the manifest's `status`, not from an empty result. bravo's
Terraform and Kubernetes collections are `not_provided`. Saying "no binding"
there would imply its running instance is unmanaged.

## Two decisions

**Tenant comes from the manifest, not the data.** The obvious alternative is
matching on the instance id, or on the ARN. Both leak. acme and bravo share an
account and an instance id, and both catalogs declare the *same* RDS ARN while
only acme's inventory holds that database. We would revisit if a future extract
put a tenant field on the records themselves.

**Generate the schema, hand-write the logic.** We tried generating an entity
layer too. It produced an `EntityKey` that could not be a dictionary key, and
enums named `Kind1`. More importantly, OpenAPI can describe field shapes but
cannot say "tenant comes from the snapshot" or "`mode: data` is not management".
That is the whole judgement. We would revisit if the source count grew.

## Verification

We assumed that being in Terraform state meant Terraform managed it. It does
not. `i-00000000000000103` is there as `data.aws_instance.lookup`, `mode: data`
— a read, not ownership.

We changed the verdict to branch on `mode`, and kept the data record in the
output as evidence with the reason `referenced_as_data_source_only`. A test
covers it. Changing the check to accept any mode fails that test and no other.

## Readiness

A read-only consumer can rely on: the three verdicts, the per-claim reference
(file, locator, `observed_at`), tenant isolation, `source` vs `derived`, and
identical output on reprocessing.

**Biggest gap: freshness.** The acme production state was observed 2026-09-02
against a one-day budget, evaluated 2026-09-16 — fourteen times over. Every
affected row says so, but a consumer that ignores `limitations` would read a
two-week-old binding as current. `binding_found` today honestly means "was
managed on 2026-09-02".

Next two changes:

1. Make staleness refuse, not annotate. Past a set multiple of the budget,
   downgrade the claim instead of footnoting it.
2. Move the identity rule out of the two question modules into one place. With
   two questions it is duplication; with three it becomes a correctness risk.

## Time and unfinished work

About four hours: one on the brief and the planted collisions, one on the spec
and generation, one and a half on the two questions, the rest on tests and this
note. A JavaScript prototype came first to work out the Kubernetes traversal,
then was ported. Both are kept and produce identical JSON.

Unfinished: the `operator_team` conflict on `i-…101` is flagged in the
Question B answer (`haveConflict`) but not repeated in the issues report.
Question B also assumes one catalog row per application per environment — true
here, but a format simplification.
