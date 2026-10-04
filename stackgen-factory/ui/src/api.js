/**
 * Everything the browser knows, it asks the control plane for.
 *
 * The token travels as a bearer header. A 401 means the token is gone or
 * expired, and the answer to that is to sign in again rather than to render an
 * error the person cannot do anything about.
 */

import { currentToken, signOut } from './auth';

async function request(path, options = {}) {
    const token = currentToken();
    const response = await fetch('/api' + path, {
        method: options.method || 'GET',
        headers: {
            ...(token ? { authorization: 'Bearer ' + token } : {}),
            ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const body = await response.json().catch(() => ({}));

    if (response.status === 401) {
        // the token expired or was never good: drop it, so the next render is
        // the sign-in screen rather than a page full of failures
        signOut();
        window.location.reload();
        throw new Error('signed out');
    }

    if (!response.ok) {
        const error = new Error(body.error || `request failed: ${response.status}`);
        error.status = response.status;
        error.body = body;
        throw error;
    }
    return body;
}

export const api = {
    me: () => request('/me'),
    policy: () => request('/policy'),

    blueprints: () => request('/blueprints'),
    blueprint: (name) => request(`/blueprints/${encodeURIComponent(name)}`),
    validateDraft: (draft) => request('/blueprints/validate', { method: 'POST', body: draft }),

    // No team and no created_by: the API takes both from the session, so there
    // is nothing here that could name another team's namespace.
    createDeployment: (blueprint, answers, type) =>
        request('/deployments', { method: 'POST', body: { blueprint, answers, type } }),
    deployments: () => request('/deployments'),
    deployment: (id) => request(`/deployments/${encodeURIComponent(id)}`),

    authoring: (name) => request(`/blueprints/${encodeURIComponent(name)}/authoring`),
    reviewDraft: (name, yaml) =>
        request(`/blueprints/${encodeURIComponent(name)}/review`, { method: 'POST', body: { yaml } }),
    saveDraft: (name, yaml) =>
        request(`/blueprints/${encodeURIComponent(name)}/draft`, { method: 'PUT', body: { yaml } }),
    publishBlueprint: (name) =>
        request(`/blueprints/${encodeURIComponent(name)}/publish`, { method: 'POST' }),

    approvals: () => request('/approvals'),
    decideGate: (specId, gate, decision) =>
        request(`/approvals/${encodeURIComponent(specId)}/${encodeURIComponent(gate)}`,
            { method: 'POST', body: { decision } }),

    runs: () => request('/runs'),
    audit: () => request('/audit'),
};
