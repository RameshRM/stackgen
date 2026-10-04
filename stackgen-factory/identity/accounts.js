'use strict';

/**
 * Who exists, and what is asserted about them.
 *
 * A mock directory. In a real deployment these claims come from the identity
 * provider's own store and nothing else about the factory changes — which is
 * the point of putting them in a token rather than in a header.
 *
 * Two claims do real work. `team` decides which namespace a deployment lands
 * in, and `roles` decides who may pass a gate. Both have to be signed by
 * somebody other than the caller.
 */
const PEOPLE = {
    'alice@acme.com': { team: 'payments', roles: ['release-manager'] },
    'bob@acme.com': { team: 'payments', roles: [] },
    'dana@acme.com': { team: 'platform', roles: ['platform-admin'] },
    'carol@bravo.com': { team: 'bravo', roles: ['release-manager'] },
};

/**
 * Services that may ask for a token without a person present.
 *
 * A bot belongs to a team, because a deployment belongs to one: a service with
 * no team can see no deployment spec and create none, which is what the first
 * version of this did. Naming them `agent:<what>:<team>` makes the audit read
 * as what happened — a bot of the payments team deployed, not a person.
 *
 * Their tokens say `principal_type: agent` whatever team they hold, so a bot
 * is refused at an approval gate. Approving is a person's own act, and a bot
 * that could do it would empty the gate of meaning.
 *
 * `factory-airflow` holds no team on purpose. It asks the policy engine
 * questions and never acts on a spec of its own, so a team would be a
 * capability it has no use for.
 */
const CLIENTS = {
    'factory-airflow': {
        secret: process.env.AIRFLOW_CLIENT_SECRET || 'airflow-secret',
        team: null,
    },
    'agent:developer:payments': {
        secret: process.env.PAYMENTS_AGENT_SECRET || 'payments-agent-secret',
        team: 'payments',
    },
    'agent:developer:platform': {
        secret: process.env.PLATFORM_AGENT_SECRET || 'platform-agent-secret',
        team: 'platform',
    },
};

module.exports = { PEOPLE, CLIENTS };
