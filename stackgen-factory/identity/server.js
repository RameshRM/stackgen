#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const http = require('http');
const jose = require('jose');

const { PEOPLE, CLIENTS } = require('./accounts');

/**
 * A mock identity provider.
 *
 * Mock in its directory and in its sign-in: the people are a file and nobody is
 * asked for a password. Real in the part the rest of the factory depends on —
 * it signs JWTs with a key it keeps, publishes the public half, and puts team
 * and roles in the claims. The control plane verifies that signature, so the
 * code path that matters in production is the one running here.
 *
 * Two kinds of caller, and the difference is the whole reason this exists:
 *
 *   a person  /authorize, through a browser     principal_type: person
 *   a service client_credentials, no browser    principal_type: agent
 *
 * A service cannot obtain a token that says `person`, because that claim is
 * written only on the branch a person goes through. That is what makes the
 * policy's "only a person may approve" enforceable rather than hopeful.
 */

const PORT = Number(process.env.IDENTITY_PORT || 4010);
const ISSUER = process.env.IDENTITY_ISSUER || 'http://127.0.0.1:' + PORT;
const AUDIENCE = process.env.FACTORY_AUDIENCE || 'factory-control-plane';
const UI = process.env.FACTORY_UI || 'http://localhost:5173';
const TTL = '1h';

// Generated at boot and never written down. A restart invalidates every token,
// which is correct for a mock and would be wrong for anything else.
let keys = null;

async function ready() {
    if (!keys) {
        keys = await jose.generateKeyPair('RS256', { extractable: true });
        const jwk = await jose.exportJWK(keys.publicKey);

        // The kid is the key's own thumbprint, not a fixed name.
        //
        // A verifier caches the key set and re-fetches only when it sees a kid
        // it does not know. This provider generates a new key every boot, so a
        // fixed kid meant the key changed while its name did not: the control
        // plane kept verifying against the key it had and rejected every token
        // until it was restarted too. A thumbprint changes when the key does,
        // which is the whole point of a key id.
        keys.kid = await jose.calculateJwkThumbprint(jwk);
        keys.jwks = {
            keys: [Object.assign(jwk, { kid: keys.kid, use: 'sig', alg: 'RS256' })],
        };
    }
    return keys;
}

async function sign(claims) {
    const { privateKey, kid } = await ready();
    return new jose.SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(TTL)
        .sign(privateKey);
}

// Authorization codes, held only until they are redeemed. One use, because a
// code that can be replayed is a token anybody who saw the redirect can mint.
const codes = new Map();

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
}

function signInPage(query) {
    const people = Object.keys(PEOPLE).map(function (id) {
        const who = PEOPLE[id];
        return `<li><a href="/authorize?${new URLSearchParams(
            Object.assign({}, query, { account: id })).toString()}">`
            + `<strong>${id}</strong>`
            + `<span>team ${who.team}`
            + (who.roles.length ? ' · ' + who.roles.join(', ') : ' · no roles')
            + `</span></a></li>`;
    }).join('');

    return `<!doctype html><meta charset="utf-8"><title>Factory sign-in</title>
<style>
 body{font:14px/1.5 system-ui;margin:0;background:#F7F6F3;color:#1A1917;
      display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#fff;border:1px solid #DEDBD4;border-radius:10px;padding:26px 28px;width:380px}
 h1{font-size:19px;margin:0 0 4px}
 p{color:#6B6862;margin:0 0 18px;font-size:13px}
 ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
 a{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
   padding:11px 13px;border:1px solid #DEDBD4;border-radius:7px;
   text-decoration:none;color:#1A1917}
 a:hover{background:#F2F0EB}
 span{font:12px ui-monospace,monospace;color:#6B6862}
 small{display:block;margin-top:16px;color:#8C8880;font-size:11px}
</style>
<div class=card>
  <h1>Sign in to the factory</h1>
  <p>Choose who to be. No password: this is a mock directory.</p>
  <ul>${people}</ul>
  <small>The token is signed. Team and roles come from it, not from you.</small>
</div>`;
}

async function handle(req, res) {
    const url = new URL(req.url, ISSUER);

    // A browser signing in is on another origin — the UI is served from one
    // port and this from another, and `localhost` and `127.0.0.1` are distinct
    // origins even on the same port. Without these headers the browser refuses
    // the request before it is sent and reports only "Failed to fetch", which
    // says nothing about why.
    //
    // Open to any origin because this is a development provider handing out
    // tokens to anyone who asks for one. A real one allows the origins it
    // knows, and that list is the point.
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
            issuer: ISSUER,
            jwks_uri: ISSUER + '/jwks',
            authorization_endpoint: ISSUER + '/authorize',
            token_endpoint: ISSUER + '/token',
            response_types_supported: ['code'],
            grant_types_supported: ['mock_password', 'client_credentials'],
            id_token_signing_alg_values_supported: ['RS256'],
            claims_supported: ['sub', 'email', 'team', 'roles', 'principal_type'],
        });
    }

    if (url.pathname === '/accounts') {
        // Who a sign-in screen may offer. A real provider publishes no such
        // thing; a mock directory has nothing to hide and the alternative is
        // the UI keeping its own copy of the list to disagree with.
        return json(res, 200, {
            accounts: Object.keys(PEOPLE).map(function (id) {
                return Object.assign({ id: id }, PEOPLE[id]);
            }),
        });
    }

    if (url.pathname === '/jwks') {
        const { jwks } = await ready();
        return json(res, 200, jwks);
    }

    if (url.pathname === '/authorize') {
        const account = url.searchParams.get('account');
        const redirect = url.searchParams.get('redirect_uri') || UI + '/callback';
        const state = url.searchParams.get('state') || '';

        if (!account) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(signInPage({ redirect_uri: redirect, state: state }));
        }
        if (!PEOPLE[account]) {
            return json(res, 400, { error: 'no such account', account: account });
        }

        const code = crypto.randomBytes(16).toString('hex');
        codes.set(code, { account: account, at: Date.now() });

        const back = new URL(redirect);
        back.searchParams.set('code', code);
        if (state) {
            back.searchParams.set('state', state);
        }
        res.writeHead(302, { location: back.toString() });
        return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
        const body = await new Promise(function (resolve) {
            let text = '';
            req.on('data', function (chunk) { text += chunk; });
            req.on('end', function () { resolve(new URLSearchParams(text)); });
        });

        const grant = body.get('grant_type');

        if (grant === 'authorization_code') {
            const issued = codes.get(body.get('code'));
            // one use: a code that can be replayed is a token for anybody who
            // saw the redirect
            codes.delete(body.get('code'));

            if (!issued || Date.now() - issued.at > 60000) {
                return json(res, 400, { error: 'invalid_grant' });
            }
            const who = PEOPLE[issued.account];
            return json(res, 200, {
                token_type: 'Bearer',
                expires_in: 3600,
                access_token: await sign({
                    sub: issued.account,
                    email: issued.account,
                    team: who.team,
                    roles: who.roles,
                    // written only here, on the branch a person goes through
                    principal_type: 'person',
                }),
            });
        }

        if (grant === 'mock_password') {
            // No redirect, no code, no state. The directory has no passwords,
            // so the dance those exist to protect was protecting nothing — it
            // only added three single-use values for a development UI to drop.
            //
            // What is kept is the only part that matters: the token is signed
            // here and verified there, so team and roles are asserted by the
            // provider rather than by the caller.
            const account = body.get('account');
            if (!PEOPLE[account]) {
                return json(res, 400, { error: 'no such account', account: account });
            }
            const who = PEOPLE[account];
            return json(res, 200, {
                token_type: 'Bearer',
                expires_in: 3600,
                access_token: await sign({
                    sub: account,
                    email: account,
                    team: who.team,
                    roles: who.roles,
                    // written only on a branch a service cannot reach
                    principal_type: 'person',
                }),
            });
        }

        if (grant === 'client_credentials') {
            const id = body.get('client_id');
            const secret = body.get('client_secret');
            const client = CLIENTS[id];
            if (!client || client.secret !== secret) {
                return json(res, 401, { error: 'invalid_client' });
            }
            return json(res, 200, {
                token_type: 'Bearer',
                expires_in: 3600,
                access_token: await sign({
                    sub: id,
                    // A bot of a team, and it says so. The team is what lets it
                    // reach that team's deployment specs and nothing else.
                    //
                    // Never any roles. A gate is passed by a person, and there
                    // is no secret a service can present that changes that.
                    principal_type: 'agent',
                    team: client.team,
                    roles: [],
                }),
            });
        }

        return json(res, 400, { error: 'unsupported_grant_type' });
    }

    json(res, 404, { error: 'no such endpoint', path: url.pathname });
}

http.createServer(function (req, res) {
    handle(req, res).catch(function (error) {
        json(res, 500, { error: error.message });
    });
}).listen(PORT, async function () {
    await ready();
    console.log('identity       ' + ISSUER);
    console.log('  discovery    ' + ISSUER + '/.well-known/openid-configuration');
    console.log('  sign in      ' + ISSUER + '/authorize');
    console.log('  people       ' + Object.keys(PEOPLE).join(', '));
    Object.keys(CLIENTS).forEach(function (id) {
        console.log('  service      ' + id
            + (CLIENTS[id].team ? '  team ' + CLIENTS[id].team : '  no team'));
    });
    console.log('  key          ' + keys.kid + ' (new every boot)');
});
