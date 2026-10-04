#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * The factory, as tools an agent can call.
 *
 * One rule decides whether this is worth having: it calls the HTTP API and
 * never the store. So policy, team scoping, bounded overrides, version
 * derivation and the audit all apply to an agent exactly as they do to a
 * browser. A server with its own database access would be a second door with
 * no lock on it — and the whole design is that the thing doing the work holds
 * no authority of its own.
 *
 * It therefore adds nothing and takes nothing away. What an agent may do is
 * whatever its token may do: a bot deploys for its team and is refused at a
 * gate; a person's token can also author. Deciding any of that here would be a
 * second place that decides, to disagree with the first.
 *
 * Identity, in order of preference:
 *
 *   FACTORY_TOKEN                a token you already hold — a person's, if you
 *                                want to author blueprints
 *   FACTORY_CLIENT_ID + SECRET   otherwise a bot, which can deploy and read
 */

const API = process.env.FACTORY_API || 'http://127.0.0.1:4000';
const ISSUER = process.env.IDENTITY_ISSUER || 'http://127.0.0.1:4010';
const CLIENT_ID = process.env.FACTORY_CLIENT_ID || 'agent:developer:payments';
const CLIENT_SECRET = process.env.FACTORY_CLIENT_SECRET || 'payments-agent-secret';

let cached = process.env.FACTORY_TOKEN || null;

async function token(force) {
    if (cached && !force) {
        return cached;
    }
    if (process.env.FACTORY_TOKEN && !force) {
        cached = process.env.FACTORY_TOKEN;
        return cached;
    }

    const response = await fetch(ISSUER + '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
        throw new Error(`the identity provider at ${ISSUER} refused ${CLIENT_ID}: `
            + (body.error || response.status));
    }
    cached = body.access_token;
    return cached;
}

/**
 * Call the control plane.
 *
 * A refusal comes back as text rather than as a thrown error, because a 403 is
 * an answer: the agent asked whether it could do something and was told no,
 * with a reason worth reading. Throwing would turn a governed refusal into a
 * malfunction.
 */
async function api(method, path, body, retried) {
    let response;
    try {
        response = await fetch(API + path, {
            method,
            headers: {
                authorization: 'Bearer ' + (await token()),
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch (error) {
        return { ok: false, text: `the control plane at ${API} could not be reached: ${error.message}` };
    }

    if (response.status === 401 && !retried) {
        await token(true);
        return api(method, path, body, true);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        return {
            ok: false,
            text: `refused (HTTP ${response.status}): ${payload.error || 'no reason given'}`,
            payload,
        };
    }
    return { ok: true, payload };
}

function said(result) {
    return {
        content: [{
            type: 'text',
            text: result.ok ? JSON.stringify(result.payload, null, 2) : result.text,
        }],
        isError: !result.ok,
    };
}

const server = new McpServer({ name: 'factory', version: '0.1.0' });

server.tool(
    'whoami',
    'Who this server is acting as, and what that identity may do. A bot deploys '
    + 'for one team and cannot pass an approval gate; a person may also author '
    + 'blueprints if they hold platform-admin.',
    {},
    async () => said(await api('GET', '/api/me')),
);

server.tool(
    'blueprints_list',
    'Every blueprint this identity may see. A blueprint governs an operation: '
    + 'what may happen, in what order, who approves, what counts as success.',
    {},
    async () => said(await api('GET', '/api/blueprints')),
);

server.tool(
    'blueprint_read',
    'One blueprint in full, with its validation.',
    { name: z.string().describe('the blueprint name') },
    async ({ name }) => said(await api('GET', `/api/blueprints/${encodeURIComponent(name)}`)),
);

server.tool(
    'blueprint_review',
    'Check a draft without saving it. Returns the same validation that '
    + 'publishing uses, plus the version this edit would produce and why — a '
    + 'major means something a developer could do, they no longer can. Always '
    + 'review before publishing: the version is derived from the change, never '
    + 'chosen, and the reasons are what you should show the person.',
    {
        name: z.string().describe('the blueprint name'),
        yaml: z.string().describe('the whole blueprint document'),
    },
    async ({ name, yaml }) => said(
        await api('POST', `/api/blueprints/${encodeURIComponent(name)}/review`, { yaml })),
);

server.tool(
    'blueprint_publish',
    'Save a draft and publish it. Requires platform-admin, so a bot token will '
    + 'be refused. The published version is frozen: a later edit becomes a new '
    + 'version and this one keeps saying what it said.',
    {
        name: z.string().describe('the blueprint name'),
        yaml: z.string().describe('the whole blueprint document'),
    },
    async ({ name, yaml }) => {
        const saved = await api('PUT',
            `/api/blueprints/${encodeURIComponent(name)}/draft`, { yaml });
        if (!saved.ok) {
            return said(saved);
        }
        return said(await api('POST',
            `/api/blueprints/${encodeURIComponent(name)}/publish`));
    },
);

server.tool(
    'deployment_create',
    'Create a deployment spec from a blueprint and answers. Creating it is what '
    + 'submits it — there is no separate run. Team and namespace are not '
    + 'arguments: they come from the token, so a deployment cannot be pointed at '
    + 'another team.',
    {
        blueprint: z.string().describe('the blueprint to resolve'),
        answers: z.record(z.any()).describe(
            'the blueprint questions, by id. Omit any with a default.'),
    },
    async ({ blueprint, answers }) => said(
        await api('POST', '/api/deployments', { blueprint, answers })),
);

server.tool(
    'deployments_list',
    'The deployment specs this identity\'s team owns.',
    {},
    async () => said(await api('GET', '/api/deployments')),
);

server.tool(
    'deployment_read',
    'One deployment spec: what it should be, what was recorded while trying, '
    + 'its gates, and its runs.',
    { id: z.string().describe('the spec id') },
    async ({ id }) => said(await api('GET', `/api/deployments/${encodeURIComponent(id)}`)),
);

server.tool(
    'approvals_list',
    'Gates waiting on a person.',
    {},
    async () => said(await api('GET', '/api/approvals')),
);

server.tool(
    'approval_decide',
    'Decide a gate. The policy engine decides whether this identity may: an '
    + 'agent is always refused, because a gate exists to require a person. Do '
    + 'not call this on somebody\'s behalf without being asked to.',
    {
        spec_id: z.string(),
        gate: z.string(),
        decision: z.enum(['approved', 'rejected']),
    },
    async ({ spec_id, gate, decision }) => said(await api('POST',
        `/api/approvals/${encodeURIComponent(spec_id)}/${encodeURIComponent(gate)}`,
        { decision })),
);

server.tool(
    'runs_list',
    'Every run of this team\'s deployment specs, newest first. A run is an '
    + 'attempt to reach a spec, not the state of the cluster.',
    {},
    async () => said(await api('GET', '/api/runs')),
);

server.tool(
    'audit_read',
    'What was decided, by whom, and why — refusals as well as permissions.',
    {},
    async () => said(await api('GET', '/api/audit')),
);

await server.connect(new StdioServerTransport());
