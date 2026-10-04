'use strict';

const cors = require('cors');
const express = require('express');

const airflow = require('./airflow');
const authoring = require('./authoring');
const blueprint = require('./blueprint');
const db = require('./db');
const principal = require('./principal');
const policy = require('./policy');
const store = require('./store');
const { submit, } = require('./submit');
const { TARGETS } = require('./resolve');
const manifests = require('./manifests');

/**
 * The control plane's HTTP surface.
 *
 * Thin over the modules that already exist and are tested. Nothing decides
 * here that is not already decided in blueprint.js or resolve.js — a route
 * that reimplemented a rule would be a second place for it to drift.
 */
function build(options) {
    // An explicit root keeps a test's deployments and store out of the project
    // tree. Blueprints are unaffected: they are source, read from the repo.
    const root = options && options.root;

    // Injectable so tests do not need a live orchestrator. In the server it is
    // the real one: a submission that cannot start its workflow says so, and
    // the spec still exists, because it does.
    const trigger = (options && options.trigger) || airflow.trigger;
    const publish = options && options.publish;

    // The decision point, injectable so a test does not need a live engine.
    // Production passes nothing and gets the real one.
    const pdp = (options && options.policy) || policy;

    // The orchestrator, for reading run state. Injectable for the same reason.
    const runs = (options && options.runs) || airflow;

    const app = express();
    app.use(cors());
    app.use(express.json());
    /**
     * Where to sign in.
     *
     * The control plane does not know who exists — that is the provider's
     * business, and asking it here would be the control plane keeping a second
     * directory to disagree with the first. All it can say is where to go.
     */
    app.get('/api/identity', function (req, res) {
        res.json({
            issuer: principal.ISSUER,
            authorize: principal.ISSUER + '/authorize',
            token: principal.ISSUER + '/token',
            audience: principal.AUDIENCE,
        });
    });

    /**
     * Generate a spec's kustomize tree, for the image the run produced.
     *
     * Called by the DAG: after build, or before the first deploy for a
     * blueprint that does not build. See manifests.js.
     *
     * OPEN: who may call this. It sits before the middleware, so it is not
     * authenticated or authorised. The intended shape is a run-scoped token —
     * issued by the identity provider, requested by the control plane when it
     * triggers the run, verified here, and checked by the policy against this
     * spec id. Until then the audit records the caller as unauthenticated,
     * because claiming it was Airflow would be the record saying something it
     * does not know.
     */
    app.post('/api/deployments/:id/manifests', function (req, res) {
        const image = req.body && req.body.image;
        if (!image || typeof image !== 'string') {
            return res.status(400).json({ error: 'an image is required' });
        }

        const id = req.params.id;
        const generated = manifests.generate({ root: root, specId: id, image: image, at: new Date().toISOString() });

        if (generated.result === 'no_such_spec') {
            return res.status(404).json({ error: 'no such deployment spec', id: id });
        }
        if (generated.result === 'already_generated') {
            return res.status(409).json({
                error: 'manifests for ' + id + ' were already generated',
                image: generated.image,
            });
        }

        db.appendAudit(db.connect(root), {
            spec_id: id,
            at: new Date().toISOString(),
            principal: { id: 'unauthenticated', type: 'unknown' },
            action: 'generate_manifests',
            target: { spec_id: id, image: image },
            decision: 'allow',
            reason: 'kustomize tree generated for ' + image + '; caller not authenticated (OPEN)',
        });
        res.status(201).json({ spec_id: id, image: image, files: generated.files });
    });

    // Before the middleware: a caller with no token needs to be able to find
    // out where to get one, and requiring a token to learn that is a loop.
    app.use(principal.middleware(options && options.jwks));

    app.get('/api/me', function (req, res) {
        res.json(req.principal);
    });

    /**
     * What the policy engine currently holds.
     *
     * Worth exposing because "loaded" is the difference between a deny that
     * means the rules refused and a cannot_tell that means nobody asked the
     * store. Both block an action; only one of them is a governance decision.
     */
    app.get('/api/policy', async function (req, res) {
        const decision = await pdp.decide({
            spec_id: '__probe__',
            action: 'deploy',
            environment: 'staging',
            principal: { id: req.principal.id, type: req.principal.type, roles: req.principal.roles },
        });
        res.json({
            engine: pdp.URL,
            reachable: await pdp.health(),
            probe: decision,
        });
    });

    /**
     * Blueprints this principal may see.
     *
     * Visibility is applied here rather than in the UI: a team-scoped
     * blueprint belonging to another team should not reach the browser at all.
     */
    app.get('/api/blueprints', function (req, res) {
        const summaries = store.listBlueprints().map(function (bp) {
            const check = blueprint.validate(bp);
            return {
                name: bp.name,
                version: bp.version,
                owner_team: bp.owner_team,
                visibility: bp.visibility,
                environments: bp.boundaries ? bp.boundaries.environments : [],
                actions: bp.boundaries ? bp.boundaries.allowed_actions : [],
                gates: (bp.sequence || [])
                    .filter(function (s) { return s.gate; })
                    .map(function (s) { return { gate: s.gate, approver_role: s.approver_role }; }),
                publishable: check.publishable,
                problems: check.errors.length,
                warnings: check.warnings.length,
                // what this principal may do with it, decided here not in the UI
                may_submit: store.visibleTo(bp, req.principal),
                may_author: principal.holds(req.principal, 'platform-admin'),
            };
        });
        res.json({ blueprints: summaries });
    });

    app.get('/api/blueprints/:name', function (req, res) {
        let bp;
        try {
            bp = blueprint.load(req.params.name);
        } catch (e) {
            return res.status(404).json({ error: 'no such blueprint', name: req.params.name });
        }

        // a blueprint another team scoped to itself does not exist as far as
        // this principal is concerned: not found, rather than forbidden
        if (!store.visibleTo(bp, req.principal)) {
            return res.status(404).json({ error: 'no such blueprint', name: req.params.name });
        }

        const check = blueprint.validate(bp);
        res.json({
            blueprint: bp,
            validation: check,
            may_submit: true,
            may_author: principal.holds(req.principal, 'platform-admin'),
            // what a spec made from this may target. From the server, so the
            // form cannot offer something resolve would refuse.
            targets: TARGETS,
        });
    });

    /** Validate a blueprint that has not been published, as the editor types. */
    app.post('/api/blueprints/validate', function (req, res) {
        if (!principal.holds(req.principal, 'platform-admin')) {
            return res.status(403).json({ error: 'authoring requires platform-admin' });
        }
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'a blueprint document is required' });
        }
        res.json(blueprint.validate(req.body));
    });

    /**
     * Authoring, all of it platform-admin.
     *
     * A developer reads blueprints and submits against them. Writing the
     * document that governs what they may do is a different job, and the API
     * is where that line is drawn — not the UI, which only hides the button.
     */
    function mustAuthor(req, res) {
        if (!principal.holds(req.principal, 'platform-admin')) {
            res.status(403).json({ error: 'authoring requires platform-admin' });
            return false;
        }
        return true;
    }

    /** The draft, the published version, and the history behind them. */
    app.get('/api/blueprints/:name/authoring', function (req, res) {
        if (!mustAuthor(req, res)) { return; }
        const store = db.connect(root);
        const name = req.params.name;
        const current = authoring.published(store, name);
        const pending = authoring.draft(store, name);

        res.json({
            name: name,
            published: current
                ? { version: current.version, file: current.file, yaml: current.yaml }
                : null,
            draft: pending
                ? { yaml: pending.yaml, authored_by: pending.authored_by,
                    updated_at: pending.updated_at }
                : null,
            history: authoring.history(store, name),
        });
    });

    /**
     * Check a draft without saving it.
     *
     * This is what the editor calls as the author types: the same validation
     * that publishing uses, plus the version the edit would produce and the
     * sentences that explain it.
     */
    app.post('/api/blueprints/:name/review', function (req, res) {
        if (!mustAuthor(req, res)) { return; }
        if (typeof (req.body && req.body.yaml) !== 'string') {
            return res.status(400).json({ error: 'a yaml document is required' });
        }
        res.json(authoring.review(db.connect(root), req.params.name, req.body.yaml));
    });

    /** Save a draft. An incomplete draft is allowed; an unpublishable one is not. */
    app.put('/api/blueprints/:name/draft', function (req, res) {
        if (!mustAuthor(req, res)) { return; }
        if (typeof (req.body && req.body.yaml) !== 'string') {
            return res.status(400).json({ error: 'a yaml document is required' });
        }
        try {
            res.json(authoring.saveDraft(
                db.connect(root), req.params.name, req.body.yaml, req.principal));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    /** Publish the draft: write the file, freeze the version, record both. */
    app.post('/api/blueprints/:name/publish', async function (req, res) {
        if (!mustAuthor(req, res)) { return; }
        const store = db.connect(root);
        let result;
        try {
            result = authoring.publish(store, req.params.name, req.principal);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        db.appendAudit(store, {
            at: result.published_at,
            principal: { id: req.principal.id, type: req.principal.type, team: req.principal.team },
            action: 'publish_blueprint',
            target: { blueprint: result.name, version: result.version, file: result.file },
            decision: 'allow',
            reason: result.level + ': ' + result.reasons.join('; '),
        });

        res.status(201).json(result);
    });

    /**
     * Submit a deployment spec.
     *
     * The body carries answers and nothing else. Team and created_by come from
     * the principal, because a developer who could name their own team could
     * deploy into another team's namespace — the namespace is derived from the
     * team, so the form must not be able to reach it.
     *
     * Creating the document is the submission; there is no separate run button.
     */
    app.post('/api/deployments', async function (req, res) {
        const body = req.body || {};
        if (!body.blueprint) {
            return res.status(400).json({ error: 'a blueprint name is required' });
        }

        let bp;
        try {
            bp = blueprint.load(body.blueprint);
        } catch (e) {
            return res.status(404).json({ error: 'no such blueprint', name: body.blueprint });
        }
        if (!store.visibleTo(bp, req.principal)) {
            return res.status(404).json({ error: 'no such blueprint', name: body.blueprint });
        }

        try {
            const result = await submit({
                blueprint: body.blueprint,
                answers: body.answers || {},
                type: body.type,
                team: req.principal.team,
                created_by: req.principal.id,
                // the type travels with the name: the audit has to be able to
                // say a bot deployed rather than attribute it to a person
                created_by_type: req.principal.type,
            }, {
                root: root,
                trigger: trigger,
                publish: publish,
            });
            // 201 because the spec was created. Whether the workflow started is
            // a separate fact and is reported as one, rather than being folded
            // into the status code.
            res.status(201).json({
                spec: result.spec,
                spec_file: result.spec_file,
                workflow: {
                    started: Boolean(result.triggered),
                    dag_id: result.triggered,
                    error: result.trigger_error,
                },
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    /** Deployment specs this principal's team owns. */
    app.get('/api/deployments', function (req, res) {
        const specs = store.deploymentIds(root).map(function (id) {
            return store.readDeployment(id, root);
        }).filter(function (spec) {
            return spec && spec.team === req.principal.team;
        });
        res.json({ deployments: specs });
    });

    app.get('/api/deployments/:id', async function (req, res) {
        const spec = store.readDeployment(req.params.id, root);
        if (!spec || spec.team !== req.principal.team) {
            return res.status(404).json({ error: 'no such deployment spec', id: req.params.id });
        }

        // Run state is the orchestrator's, so an orchestrator that cannot be
        // reached means the runs are unknown — not that there were none. The
        // page says which, because those are different sentences.
        let stageRuns = null;
        let runsError = null;
        try {
            stageRuns = await runs.runsForSpec(spec);
        } catch (error) {
            runsError = error.message;
        }

        res.json({
            spec: spec,
            audit: store.auditFor(req.params.id, root),
            approvals: store.approvalsFor(req.params.id, root),
            runs: stageRuns,
            runs_error: runsError,
        });
    });

    /** Every run of every spec this team owns, newest first. */
    app.get('/api/runs', async function (req, res) {
        const specs = store.deploymentIds(root)
            .map(function (id) { return store.readDeployment(id, root); })
            .filter(function (spec) { return spec && spec.team === req.principal.team; });

        const out = [];
        let runsError = null;
        for (const spec of specs) {
            try {
                const found = await runs.runsForSpec(spec, 5);
                found.forEach(function (run) {
                    out.push(Object.assign({ spec_id: spec.id, app_name: spec.answers.app_name }, run));
                });
            } catch (error) {
                runsError = error.message;
            }
        }

        out.sort(function (a, b) {
            return String(b.started_at || '').localeCompare(String(a.started_at || ''));
        });
        res.json({ runs: out, runs_error: runsError });
    });

    /** Gates awaiting a decision, for this principal's team. */
    app.get('/api/approvals', function (req, res) {
        res.json({
            approvals: db.pendingApprovals(db.connect(root), req.principal.team),
        });
    });

    /**
     * Decide a gate.
     *
     * Three steps, in this order:
     *
     *  1. ask the policy whether this person may decide this gate
     *  2. write the decision as a conditional update, so a second approver
     *     arriving at the same moment is told rather than silently ignored
     *  3. publish the decision to the policy engine
     *
     * Nothing is triggered. The run is already waiting on a sensor inside its
     * own DAG, and that sensor reads the decision on its next poke. A control
     * plane that also started something would be a second thing that can be
     * out of step with the first.
     *
     * Three still matters: the promotion asks the policy whether this gate was
     * passed, so a decision the engine has not been told about is a promotion
     * that gets refused. If publishing fails the response says so.
     */
    app.post('/api/approvals/:specId/:gate', async function (req, res) {
        const { specId, gate } = req.params;
        const wanted = (req.body && req.body.decision) || 'approved';
        if (wanted !== 'approved' && wanted !== 'rejected') {
            return res.status(400).json({ error: "decision must be approved or rejected" });
        }

        const connection = db.connect(root);
        const spec = store.readDeployment(specId, root);
        if (!spec || spec.team !== req.principal.team) {
            return res.status(404).json({ error: 'no such deployment spec', id: specId });
        }

        const decision = await pdp.decide({
            spec_id: specId,
            action: 'approve',
            gate: gate,
            principal: {
                id: req.principal.id,
                type: req.principal.type,
                roles: req.principal.roles,
            },
        });

        if (decision.result !== 'allow') {
            db.appendAudit(connection, {
                spec_id: specId,
                at: new Date().toISOString(),
                principal: { id: req.principal.id, type: req.principal.type, team: req.principal.team },
                action: 'approve.' + gate,
                target: { gate: gate },
                decision: decision.result,
                reason: decision.reason,
            });
            // 403 for a refusal, 409 for a gate already settled: a caller that
            // cannot tell them apart cannot tell "not you" from "not any more"
            const status = /already/.test(decision.reason || '') ? 409 : 403;
            return res.status(status).json({ error: decision.reason, result: decision.result });
        }

        const at = new Date().toISOString();
        const outcome = db.decide(connection, specId, gate, wanted, req.principal.id, at);
        if (outcome !== 'decided') {
            const current = db.approval(connection, specId, gate);
            return res.status(409).json({
                error: outcome === 'no_such_gate'
                    ? 'that gate has not been opened'
                    : 'that gate was already ' + current.state + ' by ' + current.decided_by,
            });
        }

        db.appendAudit(connection, {
            spec_id: specId,
            at: at,
            principal: { id: req.principal.id, type: req.principal.type, team: req.principal.team },
            action: 'approve.' + gate,
            target: { gate: gate },
            decision: 'allow',
            reason: decision.reason,
        });

        const row = db.approval(connection, specId, gate);

        let publishError = null;
        try {
            await pdp.recordApproval(specId, gate, {
                state: row.state,
                decided_by: row.decided_by,
                approver_role: row.approver_role,
            }, connection);
        } catch (error) {
            publishError = error.message;
        }

        // The waiting run picks this up itself. What is recorded here is that
        // the decision is now something the policy engine will honour — or that
        // it is not, in which case the promotion will be refused and the reason
        // should not be a mystery.
        db.appendAudit(connection, {
            spec_id: specId,
            at: new Date().toISOString(),
            principal: { id: 'control-plane', type: 'service' },
            action: 'gate_decided',
            target: { gate: gate, dag_id: spec.dag_id },
            decision: publishError ? 'error' : 'allow',
            reason: publishError
                ? 'the policy engine has not been told about this decision, so the'
                    + ' next action will be refused: ' + publishError
                : gate + ' ' + wanted + '; ' + spec.dag_id
                    + ' continues on its next poke',
        });

        res.json({
            approval: db.approval(connection, specId, gate),
            dag_id: spec.dag_id,
            policy_error: publishError,
        });
    });

    /**
     * The audit, for this team.
     *
     * Scoped by a join on the spec's team rather than filtered afterwards, so a
     * row belonging to another team cannot reach the response by accident.
     */
    app.get('/api/audit', function (req, res) {
        res.json({
            audit: db.auditForTeam(db.connect(root), req.principal.team,
                Number(req.query.limit) || 200),
        });
    });

    app.use('/api', function (req, res) {
        res.status(404).json({ error: 'no such endpoint', path: req.path });
    });

    return app;
}

module.exports = { build };
