'use strict';

const db = require('./db');
const policy = require('./policy');
const { resolve, save, specYaml } = require('./resolve');

/**
 * Submission, end to end.
 *
 * Nothing is written into the dags folder. One DAG factory reads every
 * deployment spec from the store and emits one DAG each, so a thousand
 * deployments are a thousand rows to read rather than a thousand files for
 * Airflow to parse.
 *
 * Writing the deployment spec is what submits it: the stages are planned and
 * the first triggered as part of recording the document. There is no separate
 * run button, because declaring the desired state is the instruction to
 * converge on it — and no button does not mean no record, so the implicit
 * submission is audited like any other action.
 */
async function submit(options, deps) {
    // async throughout: a caller should not have to catch synchronously for a
    // validation failure and asynchronously for an unreachable orchestrator
    const trigger = (deps && deps.trigger) || function () { return Promise.resolve(); };
    const publish = (deps && deps.publish) || policy.recordSpec;
    const root = deps && deps.root;
    const store = (deps && deps.db) || db.connect(root);

    const resolved = resolve(options);
    const spec = resolved.spec;
    const document = specYaml(spec);

    // the spec and what its manifests will be generated from are one fact. The
    // manifests themselves are not: they are generated after build, once there
    // is an image (manifests.js). The primary key refuses a second submission
    // on the same id before any file is created, so a resubmission cannot
    // overwrite the document recording what was deployed.
    const specFile = db.recordSpec(store, spec, document, resolved.kustomizeOptions, function () {
        return save(spec, root, document);
    });

    db.appendAudit(store, {
        at: spec.created_at,
        principal: {
            id: spec.created_by,
            // whatever the token said. A bot deploying is a bot in the
            // record; attributing it to a person would be the audit
            // saying somebody did something they did not do.
            type: options.created_by_type || 'person',
            team: spec.team,
        },
        action: 'submit',
        target: { spec_id: spec.id },
        decision: 'allow',
        reason: 'blueprint ' + spec.blueprint + ' v' + spec.blueprint_version + ' is shared',
    });

    // The spec becomes a fact the policy can read before anything acts on it.
    // If this fails the submission still stands, because the document is
    // already recorded and immutable — but it is an error, not a warning: the
    // policy will answer cannot_tell for this spec and refuse every action on
    // it until the engine is reloaded.
    let publishFailure = null;
    try {
        await publish(spec, store);
    } catch (error) {
        publishFailure = error;
    }

    db.appendAudit(store, {
        at: new Date().toISOString(),
        principal: { id: 'control-plane', type: 'service' },
        action: 'policy_record',
        target: { spec_id: spec.id },
        decision: publishFailure ? 'error' : 'allow',
        reason: publishFailure
            ? 'the policy engine does not know this spec: ' + publishFailure.message
            + '; every action on it will be refused as cannot_tell'
            : 'the policy engine can now judge actions on ' + spec.id,
    });

    // Audited after the attempt, not before it. Recording "the first triggered"
    // and then triggering would put a claim in the audit that a no-op or an
    // unreachable orchestrator turns into a lie.
    const run = spec.dag_id;
    let failure = null;
    try {
        await trigger(run, spec);
    } catch (error) {
        failure = error;
    }

    db.appendAudit(store, {
        at: new Date().toISOString(),
        principal: { id: 'control-plane', type: 'service' },
        action: 'submit_workflow',
        target: { spec_id: spec.id, dag_id: run },
        decision: failure ? 'error' : 'allow',
        reason: failure
            ? 'triggering ' + run + ' for ' + spec.id + ' failed: ' + failure.message
            : run + ' triggered for ' + spec.id,
    });

    // The trigger failure is returned, not thrown. The spec is recorded and
    // immutable by this point, so reporting the whole submission as failed would
    // be false: the caller would retry and create a second spec for one
    // intention. Two facts happened, so two facts come back — and a caller that
    // ignores trigger_error is the one place this can still go quiet, which is
    // why every caller asserts on it.
    return {
        spec: spec,
        spec_file: specFile,
        triggered: failure ? null : run,
        trigger_error: failure ? failure.message : null,
        policy_error: publishFailure ? publishFailure.message : null,
    };
}

module.exports = { submit };
