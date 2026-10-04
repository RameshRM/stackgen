'use strict';

const jose = require('jose');

/**
 * Who is calling, taken from a signed token.
 *
 * This used to read a header. Anybody could type `x-factory-user: dana@acme.com`
 * and be a platform admin, which meant every role check above it — and the
 * policy's own "only a person may approve" — was advisory.
 *
 * Now the claims are verified against the issuer's published key. The rule that
 * survives any change of provider: team and roles come from the token, never
 * from a request body, a query parameter or a header.
 *
 * `principal_type` is the claim that matters most. A service gets a token
 * through client_credentials and that branch stamps `agent`; only a person
 * signing in gets `person`. So an agent cannot claim to be one, and the policy
 * rule becomes enforceable rather than hopeful.
 */

const ISSUER = process.env.IDENTITY_ISSUER || 'http://127.0.0.1:4010';
const AUDIENCE = process.env.FACTORY_AUDIENCE || 'factory-control-plane';

// Fetched on first use and cached, with the library re-fetching when it sees a
// kid it does not know. The provider generates its key at boot, so a restart of
// the provider invalidates every token — correct for a mock, and the reason a
// cached key must not be pinned forever.
const REMOTE = jose.createRemoteJWKSet(new URL(ISSUER + '/jwks'));

function bearer(req) {
    const header = req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Check a token against a key set.
 *
 * The key set is an argument so a test can mint its own tokens and verify them
 * without a provider running. The verification itself is the same code either
 * way — stubbing it out would test the stub, and the only reason this exists is
 * to be the thing that cannot be stubbed in production.
 */
async function verify(token, keys) {
    const { payload } = await jose.jwtVerify(token, keys || REMOTE, {
        issuer: ISSUER,
        // refuses a token minted for another service and replayed here
        audience: AUDIENCE,
        // Defence in depth, and only that. A key set will not hand an RSA key
        // to an HMAC verification, so the confusion attack and `alg: none` are
        // both already refused without this — measured, not assumed. It earns
        // its place the day somebody verifies against a raw key instead.
        algorithms: ['RS256'],
    });

    return {
        id: payload.sub,
        type: payload.principal_type === 'person' ? 'person' : 'agent',
        team: payload.team || null,
        roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
}

/** The middleware, bound to a key set. */
function middleware(keys) {
    return async function (req, res, next) {
        const token = bearer(req);
        if (!token) {
            return res.status(401).json({
                error: 'no bearer token',
                sign_in: ISSUER + '/authorize',
            });
        }

        try {
            req.principal = await verify(token, keys);
            return next();
        } catch (error) {
            // the reason is returned because this is a development provider
            // and a silent 401 is the hardest thing to debug; a real one would
            // say only that the token was rejected
            return res.status(401).json({
                error: 'token rejected',
                reason: error.code || error.message,
            });
        }
    };
}

function holds(principal, role) {
    return Boolean(role) && principal.roles.includes(role);
}

module.exports = { middleware, holds, verify, ISSUER, AUDIENCE };
