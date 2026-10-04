#!/usr/bin/env node
'use strict';

/**
 * Submit a deployment spec from the command line.
 *
 *   node src/cli.js --app hello-world --image ghcr.io/acme/hello-world@sha256:abc
 *
 * Triggering is stubbed: it prints what it would POST to Airflow.
 */

const airflow = require('./airflow');
const db = require('./db');
const { submit } = require('./submit');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i === -1 ? fallback : process.argv[i + 1];
}

submit({
    blueprint: arg('blueprint', 'deploy-service'),
    answers: {
        app_name: arg('app', 'hello-world'),
        image: arg('image', 'ghcr.io/acme/hello-world@sha256:abc123'),
    },
    team: arg('team', 'payments'),
    created_by: arg('as', 'alice@acme.com'),
    id: arg('id'),
}, {
    trigger: async function (dagId, spec) {
        const run = await airflow.trigger(dagId, spec);
        console.log('  triggered      ' + run.dag_id + '  run ' + run.dag_run_id);
        return run;
    },
}).then(function (result) {
    console.log('deployment spec  ' + result.spec.id);
    console.log('  written to     ' + result.spec_file);
    result.spec.stages.forEach(function (stage) {
        console.log('  stage ' + (stage.index + 1) + '        ' + stage.dag_id
            + (stage.gate ? '  ends at gate ' + stage.gate.gate : ''));
    });
    console.log();
    console.log('audit:');
    db.auditFor(db.connect(), result.spec.id).forEach(function (e) {
        // console.log's format specifiers do not pad; do it explicitly
        console.log('  ' + e.at + '  ' + e.principal_id.padEnd(15)
            + e.action.padEnd(17) + e.decision.padEnd(7) + e.reason);
    });
    if (result.trigger_error) {
        // the spec exists; the workflow did not start. Both are worth saying,
        // and the exit code belongs to the part that failed.
        console.error();
        console.error('workflow not started: ' + result.trigger_error);
        process.exit(1);
    }
}).catch(function (err) {
    console.error('refused: ' + err.message);
    process.exit(1);
});
