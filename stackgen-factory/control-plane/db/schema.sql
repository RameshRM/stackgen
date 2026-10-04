-- The shared store.
--
-- One file, opened by the control plane and by the Airflow workers. Both
-- execute this script on open, so the schema is defined once instead of twice
-- in two languages that would drift.

PRAGMA journal_mode = WAL;   -- two processes, one file
PRAGMA foreign_keys = ON;    -- per connection, so it is set on every open

CREATE TABLE IF NOT EXISTS deployment_spec (
    id                TEXT PRIMARY KEY,
    blueprint         TEXT NOT NULL,
    blueprint_version TEXT NOT NULL,
    app_name          TEXT NOT NULL,
    team              TEXT NOT NULL,
    created_by        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    -- The run that realises this spec. Unique, and that is load-bearing: a dag
    -- id must be a Python identifier, so hyphens become underscores and the
    -- distinct spec ids `spec-0001` and `spec_0001` both yield `spec_0001`.
    -- Without this the second spec silently takes over the first one's DAG.
    dag_id            TEXT NOT NULL UNIQUE,
    -- The spec verbatim. It is immutable once written, so this cannot drift
    -- from the document on disk. The DAG factory parses this rather than
    -- walking the deployments directory.
    spec_yaml         TEXT NOT NULL
);

-- Blueprints, authored here and published to disk.
--
-- Both, deliberately. The row is the record: it holds the draft, who wrote it,
-- and which file a published version became. The file is the artifact the rest
-- of the system reads, because `blueprint.load` reads a file and a deployment
-- spec cites a version that has to remain readable long after the editor moved
-- on. A published row is never edited — an edit is a new version — so the row
-- and the file it names cannot come to disagree.
CREATE TABLE IF NOT EXISTS blueprint (
    name        TEXT NOT NULL,
    version     TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('draft', 'published')),
    owner_team  TEXT NOT NULL,
    visibility  TEXT NOT NULL,
    yaml        TEXT NOT NULL,
    -- the file this version was published to, relative to the project root.
    -- Null while it is a draft, which is what makes "published" a fact rather
    -- than something inferred from the state column alone.
    file        TEXT,
    authored_by TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (name, version)
);

-- One draft per blueprint at a time. Two half-finished edits of the same
-- governance document is a merge nobody asked for.
CREATE UNIQUE INDEX IF NOT EXISTS blueprint_one_draft
    ON blueprint (name) WHERE state = 'draft';

-- One row per gate. The primary key is what makes approval a decision rather
-- than a rewrite: a retried stage cannot open a second row, and an approval
-- cannot be reset to pending by one.
CREATE TABLE IF NOT EXISTS approval (
    spec_id       TEXT NOT NULL REFERENCES deployment_spec(id),
    gate          TEXT NOT NULL,
    approver_role TEXT,
    -- the run this gate is holding. One DAG per spec, so this is that spec's
    -- only run: the sensor inside it is what waits for a decision here.
    next_dag_id   TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
    opened_at     TEXT NOT NULL,
    decided_by    TEXT,
    decided_at    TEXT,
    PRIMARY KEY (spec_id, gate)
);

CREATE TABLE IF NOT EXISTS audit (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    spec_id        TEXT,
    at             TEXT NOT NULL,
    principal_id   TEXT NOT NULL,
    principal_type TEXT NOT NULL,
    principal_team TEXT,
    action         TEXT NOT NULL,
    decision       TEXT NOT NULL,
    reason         TEXT,
    target_json    TEXT,
    detail_json    TEXT
);

CREATE INDEX IF NOT EXISTS audit_spec ON audit (spec_id, id);

-- What a spec's kustomize tree is generated from, and the image it was
-- generated for.
--
-- Its own table rather than columns on deployment_spec, so an existing store
-- gains it on open: the schema is applied with IF NOT EXISTS and never altered.
--
-- The options are recorded at submission; the tree is not. It is generated when
-- the run reaches it — after build, or before the first deploy for a blueprint
-- that does not build — because a tree for an image that was never built is a
-- record of a deployment that cannot happen. `image` is null until then, and is
-- set once: the conditional update is what refuses a second generation.
CREATE TABLE IF NOT EXISTS manifests (
    spec_id      TEXT PRIMARY KEY REFERENCES deployment_spec(id),
    options_json TEXT NOT NULL,
    image        TEXT,
    generated_at TEXT
);
