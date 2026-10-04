'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const blueprint = require('./blueprint');

/**
 * The shared store.
 *
 * The control plane and the Airflow workers open the same file. Before this,
 * three conventions stood in for a database: a spec directory, a JSON file per
 * gate and a JSONL file per spec. The gate file was the dangerous one, because
 * two processes read it, changed it and wrote it back, and the record that lost
 * was the one naming who authorised production.
 *
 * Writes are split by who owns the fact, not by language. The control plane
 * records specs and its own actions; Airflow records gate state and what it
 * did. Neither writes the other's rows, so no row has two authors.
 */

const SCHEMA = path.join(__dirname, '..', 'db', 'schema.sql');

function file(root) {
    if (process.env.FACTORY_DB) {
        return process.env.FACTORY_DB;
    }
    return path.join(root || blueprint.ROOT, 'var', 'factory.db');
}

function open(root) {
    const target = file(root);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const db = new Database(target);
    // two processes share this file, so a writer may be mid-transaction
    db.pragma('busy_timeout = 5000');
    db.exec(fs.readFileSync(SCHEMA, 'utf8'));
    return db;
}

function json(value) {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Record a spec, and what its manifests will be generated from, as one fact.
 *
 * `writeFiles` runs inside the transaction so that a failure to write the spec
 * document leaves no row claiming the spec exists. The primary key is the guard
 * against two submissions taking the same id.
 */
function recordSpec(db, spec, specYaml, manifestOptions, writeFiles) {
    const insertSpec = db.prepare(
        'INSERT INTO deployment_spec (id, blueprint, blueprint_version, app_name,' +
        ' team, created_by, created_at, dag_id, spec_yaml)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertOptions = db.prepare(
        'INSERT INTO manifests (spec_id, options_json) VALUES (?, ?)');

    const tx = db.transaction(function () {
        insertSpec.run(
            spec.id, spec.blueprint, spec.blueprint_version,
            spec.answers.app_name, spec.team, spec.created_by,
            spec.created_at, spec.dag_id, specYaml);
        if (manifestOptions) {
            insertOptions.run(spec.id, json(manifestOptions));
        }

        return writeFiles ? writeFiles() : null;
    });

    return tx();
}

/** What a spec's manifests are generated from, and whether they have been. */
function manifests(db, specId) {
    const row = db.prepare('SELECT * FROM manifests WHERE spec_id = ?').get(specId);
    if (!row) {
        return null;
    }
    row.options = JSON.parse(row.options_json);
    return row;
}

/**
 * Record that a spec's manifests were generated for an image.
 *
 * One conditional UPDATE, for the same reason as a gate decision: a retried
 * task arriving twice must not regenerate a tree a deploy may already be
 * applying. `writeFiles` runs inside the transaction, so a tree that fails to
 * write leaves the row unset and the next attempt may try again.
 *
 * Returns 'generated', 'already_generated' or 'no_such_spec'.
 */
function recordManifests(db, specId, image, at, writeFiles) {
    const tx = db.transaction(function () {
        const result = db.prepare(
            'UPDATE manifests SET image = ?, generated_at = ?' +
            ' WHERE spec_id = ? AND image IS NULL'
        ).run(image, at, specId);

        if (result.changes === 1) {
            if (writeFiles) {
                writeFiles();
            }
            return 'generated';
        }
        return manifests(db, specId) ? 'already_generated' : 'no_such_spec';
    });

    return tx();
}

function appendAudit(db, record) {
    const principal = record.principal || {};
    return db.prepare(
        'INSERT INTO audit (spec_id, at, principal_id, principal_type,' +
        ' principal_team, action, decision, reason, target_json, detail_json)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        record.spec_id || (record.target && record.target.spec_id) || null,
        record.at, principal.id, principal.type, principal.team || null,
        record.action, record.decision, record.reason || null,
        json(record.target), json(record.detail));
}

function specRow(db, id) {
    return db.prepare('SELECT * FROM deployment_spec WHERE id = ?').get(id) || null;
}

function specRows(db) {
    return db.prepare('SELECT * FROM deployment_spec ORDER BY id').all();
}

function approvals(db, specId) {
    return db.prepare('SELECT * FROM approval WHERE spec_id = ? ORDER BY gate').all(specId);
}

function approval(db, specId, gate) {
    return db.prepare(
        'SELECT * FROM approval WHERE spec_id = ? AND gate = ?').get(specId, gate) || null;
}

/**
 * Record a decision on a gate.
 *
 * One conditional UPDATE, not a read followed by a write. Two approvers arriving
 * together both run this; SQLite applies them one at a time and only the first
 * matches `state = 'pending'`. The second changes no rows and is told the gate
 * was already decided, rather than silently overwriting the name of whoever
 * authorised production.
 *
 * Returns 'decided', 'already_<state>' or 'no_such_gate'.
 */
function decide(db, specId, gate, state, decidedBy, decidedAt) {
    const result = db.prepare(
        'UPDATE approval SET state = ?, decided_by = ?, decided_at = ?' +
        " WHERE spec_id = ? AND gate = ? AND state = 'pending'"
    ).run(state, decidedBy, decidedAt, specId, gate);

    if (result.changes === 1) {
        return 'decided';
    }

    const row = approval(db, specId, gate);
    return row ? 'already_' + row.state : 'no_such_gate';
}

/** Every gate awaiting a decision, for the specs a team owns. */
function pendingApprovals(db, team) {
    return db.prepare(
        'SELECT a.*, s.team, s.blueprint, s.app_name FROM approval a' +
        ' JOIN deployment_spec s ON s.id = a.spec_id' +
        " WHERE a.state = 'pending' AND s.team = ?" +
        ' ORDER BY a.opened_at'
    ).all(team);
}

/** The audit across every spec a team owns, newest first. */
function auditForTeam(db, team, limit) {
    return db.prepare(
        'SELECT a.*, s.app_name FROM audit a' +
        ' JOIN deployment_spec s ON s.id = a.spec_id' +
        ' WHERE s.team = ? ORDER BY a.id DESC LIMIT ?'
    ).all(team, limit || 200).map(function (row) {
        row.target = row.target_json ? JSON.parse(row.target_json) : null;
        row.detail = row.detail_json ? JSON.parse(row.detail_json) : null;
        return row;
    });
}

function auditFor(db, specId) {
    return db.prepare(
        'SELECT * FROM audit WHERE spec_id = ? ORDER BY id').all(specId).map(function (row) {
            row.target = row.target_json ? JSON.parse(row.target_json) : null;
            row.detail = row.detail_json ? JSON.parse(row.detail_json) : null;
            return row;
        });
}

/**
 * One connection per database file, reused.
 *
 * The API server is long lived and a connection per request would leak handles.
 * Keyed by path so a test pointing at its own temporary root gets its own
 * connection rather than another test's.
 */
const connections = new Map();

function connect(root) {
    const target = file(root);
    if (!connections.has(target)) {
        connections.set(target, open(root));
    }
    return connections.get(target);
}

module.exports = {
    open, connect, file, recordSpec, manifests, recordManifests, appendAudit,
    specRow, specRows, approvals, approval, auditFor, auditForTeam,
    decide, pendingApprovals,
};
