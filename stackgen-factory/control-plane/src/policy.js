'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const blueprint = require('./blueprint');
const db = require('./db');

/**
 * The policy decision point.
 *
 * The control plane records two things here: the rules, and the facts the rules
 * read. A caller then sends only what it intends to do and who it claims to be.
 * That asymmetry is the whole design — an Airflow worker asking whether it may
 * promote cannot also assert that the promotion was approved, because it has
 * nothing to assert it with.
 *
 * The store stays the record. What is in the engine is derived from it and can
 * be rebuilt at any time, which is what `load` is for: OPA restarts empty, and
 * an engine holding rules but no facts must not answer with confidence.
 */

// 127.0.0.1, not localhost: Node 18's fetch resolves localhost to ::1 first and
// the engine binds IPv4, so the name works from curl and fails from here.
const URL = process.env.OPA_URL || 'http://127.0.0.1:8181';
const POLICY_DIR = path.join(blueprint.ROOT, 'policies');
const POLICY_ID = 'factory';

async function send(method, route, body, contentType) {
    let response;
    try {
        response = await fetch(URL + route, {
            method: method,
            headers: contentType ? { 'content-type': contentType } : {},
            body: body,
        });
    } catch (error) {
        throw new Error('policy engine unreachable at ' + URL + ': ' + error.message);
    }
    if (!response.ok) {
        const detail = await response.text();
        throw new Error('policy engine refused ' + method + ' ' + route + ': ' + detail);
    }
    return response;
}

/** Record the rules. The .rego file is the artifact; this only uploads it. */
async function putPolicy() {
    const file = path.join(POLICY_DIR, POLICY_ID + '.rego');
    const source = fs.readFileSync(file, 'utf8');
    await send('PUT', '/v1/policies/' + POLICY_ID, source, 'text/plain');
    return file;
}

async function putData(route, value) {
    await send('PUT', '/v1/data/' + route, JSON.stringify(value), 'application/json');
}

/**
 * Rebuild the facts from the store.
 *
 * `loaded_at` is written last, on purpose. The policy answers cannot_tell while
 * it is absent, so a load that fails half way leaves the engine admitting it
 * does not know rather than denying every gate with confidence.
 */
async function load(store) {
    const connection = store || db.connect();

    const specs = {};
    db.specRows(connection).forEach(function (row) {
        specs[row.id] = YAML.parse(row.spec_yaml);
    });

    const approvals = {};
    Object.keys(specs).forEach(function (id) {
        db.approvals(connection, id).forEach(function (row) {
            if (!approvals[id]) {
                approvals[id] = {};
            }
            approvals[id][row.gate] = {
                state: row.state,
                decided_by: row.decided_by,
                approver_role: row.approver_role,
            };
        });
    });

    await putData('specs', specs);
    await putData('approvals', approvals);
    await putData('loaded_at', new Date().toISOString());

    return { specs: Object.keys(specs).length, approvals: Object.keys(approvals).length };
}

/** Whether the engine already holds a full load. */
async function isLoaded() {
    try {
        const response = await fetch(URL + '/v1/data/loaded_at');
        if (!response.ok) {
            return false;
        }
        const body = await response.json();
        return Boolean(body.result);
    } catch (error) {
        return false;
    }
}

/**
 * Write one fact through to the engine.
 *
 * An incremental write never sets `loaded_at`. If it did, an engine that had
 * restarted empty would start claiming to be loaded while holding one spec and
 * no approvals, and every gate on every other spec would come back as a
 * confident deny instead of cannot_tell. So when the marker is missing the whole
 * store is reloaded instead, and the marker goes on last as it always does.
 *
 * A full reload per write is the wrong shape for thousands of specs. It is the
 * right shape for correctness, and the incremental path below is what keeps it
 * off the common case.
 */
async function record(route, value, store) {
    if (!(await isLoaded())) {
        return load(store);
    }
    await putData(route, value);
    return null;
}

/** A spec became a fact. */
async function recordSpec(spec, store) {
    return record('specs/' + encodeURIComponent(spec.id), spec, store);
}

/** A gate was decided. */
async function recordApproval(specId, gate, approval, store) {
    return record(
        'approvals/' + encodeURIComponent(specId) + '/' + encodeURIComponent(gate),
        approval, store);
}

/**
 * Ask whether something may happen.
 *
 * An unreachable engine is cannot_tell, not an exception. A caller that had to
 * catch would be one refactor away from treating a failure as permission, and
 * the three outcomes exist so that "we could not tell" survives as its own
 * answer rather than collapsing into one of the other two.
 */
async function decide(input) {
    let response;
    try {
        response = await send('POST', '/v1/data/factory/decision',
            JSON.stringify({ input: input }), 'application/json');
    } catch (error) {
        return { result: 'cannot_tell', reason: error.message };
    }

    const body = await response.json();
    if (!body.result) {
        // the rule did not evaluate: an empty result is not an allow
        return { result: 'cannot_tell', reason: 'the policy returned no decision' };
    }
    return body.result;
}

/** Whether the engine is answering at all, asked directly rather than inferred. */
async function health() {
    try {
        const response = await fetch(URL + '/health');
        return response.ok;
    } catch (error) {
        return false;
    }
}

module.exports = {
    putPolicy, putData, load, decide, health,
    isLoaded, recordSpec, recordApproval,
    URL, POLICY_ID,
};
