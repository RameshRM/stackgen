'use strict';

const fs = require('fs');
const path = require('path');

const blueprint = require('./blueprint');

/**
 * The orchestrator, over its REST API.
 *
 * The control plane does not shell out to the airflow CLI and does not write
 * into the dags folder. It asks the API, which is the only interface a separate
 * service is entitled to assume.
 *
 * Three things here are not obvious and each one was a bug first:
 *
 *  - 127.0.0.1, not localhost. Node 18's fetch resolves localhost to ::1 and
 *    Airflow binds IPv4, so the name works from curl and fails from here.
 *  - A DAG must be unpaused before it is triggered. A run posted to a paused
 *    DAG is created and never executes, which looks exactly like success.
 *  - A new deployment spec is not a DAG yet. One file emits every DAG and its
 *    contents do not change when a spec is added, so the trigger waits for the
 *    processor to come round rather than assuming the DAG is there.
 */

const URL = process.env.AIRFLOW_API_URL || 'http://127.0.0.1:8080';
const USERNAME = process.env.AIRFLOW_USERNAME || 'admin';

// How long to wait for a newly written spec to become a DAG. The processor
// re-reads on its own interval; this is that interval plus room to spare.
const APPEAR_TIMEOUT_MS = Number(process.env.AIRFLOW_APPEAR_TIMEOUT_MS || 45000);
const POLL_MS = 2000;

/**
 * The password.
 *
 * From the environment in any real deployment. The fallback reads the file
 * Airflow itself generates for its local standalone admin, so a development
 * machine works without exporting anything; it is inside airflow-home, which is
 * not in version control.
 */
function password() {
    if (process.env.AIRFLOW_PASSWORD) {
        return process.env.AIRFLOW_PASSWORD;
    }
    const generated = path.join(
        blueprint.ROOT, 'airflow-home', 'simple_auth_manager_passwords.json.generated');
    if (!fs.existsSync(generated)) {
        throw new Error('no AIRFLOW_PASSWORD set and no generated password file at '
            + generated);
    }
    const people = JSON.parse(fs.readFileSync(generated, 'utf8'));
    if (!people[USERNAME]) {
        throw new Error('the generated password file has no entry for ' + USERNAME);
    }
    return people[USERNAME];
}

let cached = null;

async function token(force) {
    if (cached && !force) {
        return cached;
    }
    const response = await fetch(URL + '/auth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USERNAME, password: password() }),
    });
    if (!response.ok) {
        throw new Error('airflow rejected the credentials: HTTP ' + response.status);
    }
    const body = await response.json();
    cached = body.access_token;
    return cached;
}

/** Call the API, retrying once with a fresh token if the old one has expired. */
async function call(method, route, body) {
    const send = async function (bearer) {
        return fetch(URL + route, {
            method: method,
            headers: Object.assign(
                { authorization: 'Bearer ' + bearer },
                body ? { 'content-type': 'application/json' } : {}),
            body: body ? JSON.stringify(body) : undefined,
        });
    };

    let response = await send(await token());
    if (response.status === 401) {
        response = await send(await token(true));
    }
    return response;
}

async function dag(dagId) {
    const response = await call('GET', '/api/v2/dags/' + encodeURIComponent(dagId));
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error('airflow refused to describe ' + dagId + ': HTTP ' + response.status);
    }
    return response.json();
}

/**
 * Wait until the processor has parsed the DAG for this stage.
 *
 * Returns the DAG, or throws. It does not return quietly on timeout: a caller
 * that could not tell "not there yet" from "never going to be there" would
 * report a submission as started when nothing runs.
 */
async function waitForDag(dagId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || APPEAR_TIMEOUT_MS);
    for (;;) {
        const found = await dag(dagId);
        if (found) {
            return found;
        }
        if (Date.now() >= deadline) {
            throw new Error(dagId + ' had not been parsed after '
                + Math.round((timeoutMs || APPEAR_TIMEOUT_MS) / 1000)
                + 's; is the dag processor running?');
        }
        await new Promise(function (resolve) { setTimeout(resolve, POLL_MS); });
    }
}

async function unpause(dagId) {
    const response = await call(
        'PATCH', '/api/v2/dags/' + encodeURIComponent(dagId) + '?update_mask=is_paused',
        { is_paused: false });
    if (!response.ok) {
        throw new Error('could not unpause ' + dagId + ': HTTP ' + response.status
            + ' ' + (await response.text()).slice(0, 200));
    }
}

/**
 * Start one stage.
 *
 * The run id names the spec so that a run in the Airflow UI can be traced back
 * to the document that asked for it.
 */
async function triggerDag(dagId, spec) {
    const at = new Date().toISOString();
    const response = await call(
        'POST', '/api/v2/dags/' + encodeURIComponent(dagId) + '/dagRuns', {
            dag_run_id: (spec ? spec.id : dagId) + '__' + at.replace(/[:.]/g, '-'),
            logical_date: at,
            conf: spec ? { spec_id: spec.id, team: spec.team } : {},
            note: spec ? 'requested by the control plane for ' + spec.id : undefined,
        });

    if (!response.ok) {
        throw new Error('could not trigger ' + dagId + ': HTTP ' + response.status
            + ' ' + (await response.text()).slice(0, 300));
    }
    return response.json();
}

/**
 * Wait for the DAG, unpause it, run it. In that order, for the reasons above.
 */
/**
 * The runs of one stage, newest first.
 *
 * Airflow owns run state, so it is asked rather than mirrored. A second copy in
 * the store would be a copy that goes stale the moment a task retries, and the
 * screen showing it would be confidently wrong.
 */
async function runsFor(dagId, limit) {
    const response = await call('GET',
        '/api/v2/dags/' + encodeURIComponent(dagId) + '/dagRuns'
        + '?order_by=-logical_date&limit=' + (limit || 10));
    if (response.status === 404) {
        return [];
    }
    if (!response.ok) {
        throw new Error('could not list runs of ' + dagId + ': HTTP ' + response.status);
    }
    const body = await response.json();
    return (body.dag_runs || []).map(function (run) {
        return {
            dag_id: dagId,
            dag_run_id: run.dag_run_id,
            state: run.state,
            started_at: run.start_date,
            ended_at: run.end_date,
        };
    });
}

/** The runs of every stage of a spec, newest first across all stages. */
async function runsForSpec(spec, limit) {
    const perStage = await Promise.all((spec.stages || []).map(function (stage) {
        return runsFor(stage.dag_id, limit);
    }));
    return perStage.flat().sort(function (a, b) {
        return String(b.started_at || '').localeCompare(String(a.started_at || ''));
    });
}

async function trigger(dagId, spec) {
    await waitForDag(dagId);
    await unpause(dagId);
    const run = await triggerDag(dagId, spec);
    return { dag_id: dagId, dag_run_id: run.dag_run_id, state: run.state };
}

module.exports = {
    trigger, triggerDag, waitForDag, unpause, dag,
    runsFor, runsForSpec, token, URL,
};
