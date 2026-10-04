#!/usr/bin/env node
'use strict';

const blueprint = require('./blueprint');
const { build } = require('./api');
const policy = require('./policy');

const PORT = Number(process.env.PORT || 4000);

/**
 * Record the rules and the facts, then listen.
 *
 * A policy engine that cannot be reached does not stop the control plane from
 * starting, because reading a blueprint needs no decision. It does stop anything
 * from being done: every decision comes back cannot_tell, which is a refusal.
 * So the failure is loud here rather than silent later.
 */
async function start() {
    try {
        const file = await policy.putPolicy();
        const loaded = await policy.load();
        console.log('policy         ' + file.replace(blueprint.ROOT + '/', ''));
        console.log('  engine       ' + policy.URL);
        console.log('  loaded       ' + loaded.specs + ' specs, '
            + loaded.approvals + ' with approvals');
    } catch (error) {
        console.error('POLICY ENGINE NOT LOADED: ' + error.message);
        console.error('  every decision will be cannot_tell, which refuses every action');
    }

    build().listen(PORT, function () {
        console.log('control plane  http://localhost:' + PORT);
    });
}

start();
