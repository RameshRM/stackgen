'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const blueprint = require('./blueprint');
const db = require('./db');

/**
 * Reads.
 *
 * Blueprints are files, because they are hand-written and version controlled: a
 * database row cannot be code-reviewed. Everything a run produces lives in the
 * shared store instead. Nothing here writes.
 */

function root(sub, base) {
    return path.join(base || blueprint.ROOT, sub);
}

function listBlueprints(base) {
    const dir = root('blueprints', base);
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir)
        .filter(function (f) { return f.endsWith('.yaml'); })
        .map(function (f) { return YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')); })
        .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
}

/**
 * Whether a principal may submit against a blueprint.
 *
 * A shared blueprint is open to every team; a team-scoped one only to the team
 * that owns it. Authoring is separate and needs platform-admin.
 */
function visibleTo(bp, principal) {
    return bp.visibility === 'shared' || bp.owner_team === principal.team;
}

function deploymentIds(root) {
    return db.specRows(db.connect(root)).map(function (row) { return row.id; });
}

/** The deployment spec as it was recorded, parsed. */
function readDeployment(id, root) {
    const row = db.specRow(db.connect(root), id);
    return row ? YAML.parse(row.spec_yaml) : null;
}

/** What was recorded against one deployment spec, oldest first. */
function auditFor(id, root) {
    return db.auditFor(db.connect(root), id);
}

/** The gates opened on one deployment spec, and how each was decided. */
function approvalsFor(id, root) {
    return db.approvals(db.connect(root), id);
}

module.exports = {
    listBlueprints, visibleTo, deploymentIds, readDeployment,
    auditFor, approvalsFor, root,
};
