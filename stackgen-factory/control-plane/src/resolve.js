'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const blueprint = require('./blueprint');
const dag = require('./dag');
const sequenceGraph = require('./sequence');

/** What a deployment spec may describe. */
const TARGETS = ['k8s'];

/** Substitute {{ name }} throughout a structure, from a flat map of answers. */
function fill(value, answers) {
    if (typeof value === 'string') {
        const whole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
        if (whole) {
            // a lone placeholder keeps its own type: 0.01 stays a number
            return Object.prototype.hasOwnProperty.call(answers, whole[1]) ? answers[whole[1]] : value;
        }
        return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (match, name) {
            return Object.prototype.hasOwnProperty.call(answers, name) ? String(answers[name]) : match;
        });
    }
    if (Array.isArray(value)) {
        return value.map(function (item) { return fill(item, answers); });
    }
    if (value && typeof value === 'object') {
        const out = {};
        Object.keys(value).forEach(function (key) { out[key] = fill(value[key], answers); });
        return out;
    }
    return value;
}

/** Apply a question's declared default when no answer was supplied. */
function withDefaults(questions, supplied) {
    const answers = {};
    (questions || []).forEach(function (question) {
        if (Object.prototype.hasOwnProperty.call(supplied, question.id)) {
            answers[question.id] = supplied[question.id];
        } else if (Object.prototype.hasOwnProperty.call(question, 'default')) {
            answers[question.id] = question.default;
        }
    });
    return answers;
}

function missingAnswers(questions, answers) {
    return (questions || [])
        .filter(function (q) { return !Object.prototype.hasOwnProperty.call(answers, q.id); })
        .map(function (q) { return q.id; });
}

/**
 * The environment the last action in the sequence targets.
 *
 * That is the one a developer's override reaches. It is derived from the
 * sequence rather than named, so a blueprint running dev, qa, prod needs no
 * extra configuration to behave the same way.
 */
function finalEnvironment(sequence) {
    const actions = (sequence || []).filter(function (step) { return step.action; });
    if (!actions.length) {
        throw new Error('the sequence contains no action, so there is nothing to size');
    }
    return actions[actions.length - 1].environment;
}

/**
 * Check the values a developer may override against the bounds that permit them.
 *
 * A value with no declared bound cannot be overridden at all: silently
 * accepting one would mean the blueprint governs less than it appears to.
 */
function checkOverrides(workload, supplied) {
    const problems = [];
    if (!workload) {
        return problems;
    }

    if (Object.prototype.hasOwnProperty.call(supplied, 'memory')) {
        const permitted = (workload.memory || {}).values;
        if (!permitted) {
            problems.push('memory cannot be overridden: the blueprint declares no permitted values');
        } else if (!permitted.includes(supplied.memory)) {
            problems.push('memory ' + supplied.memory + ' is not one of ['
                + permitted.join(', ') + ']');
        }
    }

    if (Object.prototype.hasOwnProperty.call(supplied, 'replicas')) {
        const max = (workload.replicas || {}).max;
        if (max === undefined) {
            problems.push('replicas cannot be overridden: the blueprint declares no max');
        } else if (supplied.replicas > max) {
            problems.push('replicas ' + supplied.replicas + ' is above the max of ' + max);
        } else if (supplied.replicas < 1) {
            problems.push('replicas must be at least 1');
        }
    }

    return problems;
}

/**
 * Resolve a blueprint and a set of answers into a deployment spec.
 *
 * The result is the WISB for one deployment: every placeholder filled, the
 * blueprint version and commit recorded so the document can be traced back,
 * and nothing left that is still a template.
 */
function resolve(options) {
    const name = options.blueprint;
    const supplied = options.answers || {};
    const team = options.team;
    const createdBy = options.created_by;
    const now = options.now || new Date().toISOString();

    // Only one target can be realised today. It is named on the spec rather than
    // assumed, so a second one arriving does not make every existing document
    // ambiguous about which it meant.
    const type = options.type || 'k8s';
    if (!TARGETS.includes(type)) {
        throw new Error(type + ' is not a target this can realise; expected one of ['
            + TARGETS.join(', ') + ']');
    }

    if (!team) {
        // the team comes from the caller's session, never from a form
        throw new Error('team is required and must come from the authenticated principal');
    }

    const source = blueprint.load(name);
    const check = blueprint.validate(source);
    if (!check.publishable) {
        throw new Error('blueprint ' + name + ' does not validate: ' + check.errors[0].message);
    }

    const specId = options.id || ('spec-' + crypto.randomBytes(4).toString('hex'));
    const answers = withDefaults(source.questions, supplied);

    // A blueprint that builds does not ask for an image: it produces one, and
    // the spec does not name it in advance. The build reports the image it
    // made, tagged with the commit it was built from, and the manifests are
    // generated then — see manifests.js.

    const missing = missingAnswers(source.questions, answers);
    if (missing.length) {
        throw new Error('missing answers: ' + missing.join(', '));
    }

    // an override is the developer's choice, but only inside the bounds the
    // blueprint declared: self-service within rails, not instead of them
    const overrides = checkOverrides(source.workload, supplied);
    if (overrides.length) {
        throw new Error(overrides[0]);
    }

    // The namespace is derived, never asked. The team comes from the session
    // and the environment from the step, so there is nothing for a developer
    // to get wrong or to point at another team.
    const namespaces = {};
    (source.boundaries.environments || []).forEach(function (environment) {
        namespaces[environment] = team + '-' + environment;
    });

    // Ids and dependencies are resolved into the spec, so the run is built from
    // one description of the graph rather than from a rule applied twice.
    const sequence = sequenceGraph.resolveGraph(fill(source.sequence, answers))
        .map(function (step) {
            if (step.gate) {
                return step;
            }
            return Object.assign({}, step, { namespace: namespaces[step.environment] });
        });

    // An accepted override reaches the last environment in the sequence only.
    // Earlier environments are there to be tested in, not to be sized by the
    // developer: staging stays small whatever production is set to.
    const last = finalEnvironment(source.sequence);

    const replicas = Object.assign({}, source.workload.replicas);
    if (Object.prototype.hasOwnProperty.call(supplied, 'replicas')) {
        // written as that environment's own entry, leaving the default alone
        replicas[last] = supplied.replicas;
    }

    // Memory is overridden the same way, by becoming that environment's own
    // entry. Writing it anywhere else is how it came to be validated and then
    // ignored: the generator reads the workload, so an override that does not
    // reach the workload does nothing.
    //
    // One chosen value sets requests and limits together. The blueprint offers
    // scalars, so there is no second number to put in the other field, and
    // setting only the limit could leave requests above it, which Kubernetes
    // rejects.
    const memory = Object.assign({}, source.workload.memory);
    if (Object.prototype.hasOwnProperty.call(supplied, 'memory')) {
        memory[last] = { requests: supplied.memory, limits: supplied.memory };
    }

    const workload = Object.assign({}, source.workload,
        { replicas: replicas, memory: memory });

    const spec = {
        id: specId,
        // What kind of thing this describes. One blueprint serves many
        // deployment specs and they need not all land in the same place, so the
        // target belongs to the spec rather than to the blueprint that governs
        // it. Only k8s is realisable today, and `validate` refuses anything
        // else — the day a second exists, no spec silently means this one.
        type: type,
        team: team,
        created_at: now,
        created_by: createdBy,

        blueprint: source.name,
        blueprint_version: source.version,

        answers: answers,

        // boundaries travel with the spec: the policy check reads them at
        // runtime and must not have to fetch the blueprint again
        boundaries: source.boundaries,

        // The sequence is the plan. It says what happens, in order, with the
        // gates where they belong, and the DAG factory walks it directly — there
        // is nothing to precompute and therefore nothing to precompute wrongly.
        sequence: sequence,

        // the one run that realises this spec
        dag_id: dag.dagId(specId),

        // the kustomize tree generated beside this spec is what gets applied.
        // It is generated after build, not here, and Airflow renders it per
        // environment at deploy time
        kustomize: 'kustomize/overlays/{environment}',
        record: source.record || [],
        acceptance: fill(source.acceptance || [], answers),
    };

    return {
        spec: spec,
        // Everything the kustomize tree needs except the image, recorded with
        // the spec so the tree can be generated later from what was resolved
        // now. The image is supplied when the tree is generated.
        kustomizeOptions: {
            app_name: answers.app_name,
            // the blueprint is a dimension of every metric this workload emits
            blueprint: source.name,
            // how the application is spoken to, from the answers. Absent means
            // absent: a workload that listens on nothing gets no port, no probe
            // and no scrape annotation, rather than those fields set to
            // undefined.
            port: answers.port,
            health_path: answers.health_path,
            metrics_path: answers.metrics_path,
            workload: workload,
            team: team,
            spec_id: spec.id,
            environments: source.boundaries.environments,
            namespaces: namespaces,
        },
    };
}

/**
 * A deployment spec is a directory: the document, and — once the run has an
 * image — the kustomize tree generated beside it. Exclusive create, because two
 * submissions racing on the same id would otherwise both pass an existence
 * check and the second would overwrite the first.
 */
/** The spec as the document it is stored as, in one place. */
function specYaml(spec) {
    return YAML.stringify(spec);
}

/**
 * Write the spec document into its own directory.
 *
 * The document is also held in the store; the spec is immutable, so the two
 * copies cannot come to disagree. The kustomize tree is not written here: it is
 * generated after build, into this same directory (manifests.js).
 *
 * If the write fails the directory is removed, so a caller that rolls back its
 * own transaction is not left with a directory claiming a spec exists.
 */
function save(spec, root, yamlText) {
    const parent = path.join(root || blueprint.ROOT, 'deployments');
    fs.mkdirSync(parent, { recursive: true });

    // not recursive: this throws if the id is taken, so two submissions racing
    // on the same id cannot both proceed
    const dir = path.join(parent, spec.id);
    fs.mkdirSync(dir, { recursive: false });

    try {
        const file = path.join(dir, 'spec.yaml');
        fs.writeFileSync(file, yamlText || specYaml(spec), { flag: 'wx' });
        return file;
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
    }
}

module.exports = { resolve, save, specYaml, fill, withDefaults, TARGETS };
