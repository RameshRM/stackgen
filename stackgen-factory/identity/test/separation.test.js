'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { PEOPLE, CLIENTS } = require('../accounts');

/**
 * People and bots are different populations, and nothing may blur them.
 *
 * A bot exists so that automated work is recorded as automated. If a bot could
 * be signed into from the login screen, that record would be a person's name
 * against a machine's work — and the gate, which exists to require a human,
 * would be passable by whatever holds the secret.
 */

test('no bot appears in the directory a sign-in screen reads', function () {
    Object.keys(PEOPLE).forEach(function (id) {
        assert.ok(!id.startsWith('agent:'),
            id + ' is a bot and must not be sign-in-able');
    });
});

test('no person is a client that can present a secret', function () {
    Object.keys(CLIENTS).forEach(function (id) {
        assert.ok(!PEOPLE[id],
            id + ' is in both populations; it must be one or the other');
    });
});

// Catches: a bot given a role, which would let it pass a gate the moment the
// policy stopped checking the type as well.
test('no bot holds a role', function () {
    Object.keys(CLIENTS).forEach(function (id) {
        assert.ok(!CLIENTS[id].roles,
            id + ' carries roles; a bot is refused at a gate and must not look '
            + 'as though it could pass one');
    });
});

// Catches: a client with no secret, which is an account anybody may be.
test('every bot has a secret', function () {
    Object.keys(CLIENTS).forEach(function (id) {
        assert.ok(CLIENTS[id].secret && CLIENTS[id].secret.length > 0,
            id + ' has no secret');
    });
});
