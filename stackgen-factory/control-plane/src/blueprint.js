'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const sequence = require('./sequence');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Read a blueprint by name. The name is the operation, never one application.
 *
 * The root is an argument only so that authoring can publish into a scratch
 * tree in its own tests. Everything else omits it: blueprints are source, read
 * from the project, and a deployment spec resolved against a blueprint that
 * lived somewhere else would be a document nobody can trace.
 */
function load(name, root) {
    const file = path.join(root || ROOT, 'blueprints', name + '.yaml');
    return YAML.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The value a setting takes for one environment: its own, or the default.
 *
 * `max` and `values` are bounds, not environments, so they are never a value.
 */
function settingFor(setting, environment) {
    if (setting && typeof setting === 'object'
        && Object.prototype.hasOwnProperty.call(setting, environment)) {
        return setting[environment];
    }
    return setting && typeof setting === 'object' && 'default' in setting
        ? setting.default
        : undefined;
}

/**
 * Check a blueprint against its own boundaries.
 *
 * Errors block publication: they describe a step that would be refused at
 * runtime, so the blueprint could never do what it says. Warnings do not: a
 * gate with no role is still a gate, just a weaker one than it looks.
 *
 * A blueprint governs; it does not describe resources. What gets created and
 * how it differs by environment lives in the resource spec, so nothing here
 * reads one.
 */
function validate(blueprint) {
    const errors = [];
    const warnings = [];

    const boundaries = blueprint.boundaries || {};
    const allowedActions = boundaries.allowed_actions || [];
    const allowedEnvironments = boundaries.environments || [];

    if (!blueprint.boundaries) {
        // an absent boundaries block permits nothing; it does not permit all
        errors.push({ field: 'boundaries', message: 'boundaries is missing, so every action would be refused' });
    }
    if (!blueprint.sequence || !blueprint.sequence.length) {
        errors.push({ field: 'sequence', message: 'sequence is missing, so there is nothing to orchestrate' });
    } else {
        // A sequence is a graph. A duplicate id, a dependency on a step that is
        // not there, or a cycle all make it unrunnable, and all three have to be
        // refused here rather than found when Airflow fails to parse it.
        sequence.problems(blueprint.sequence).forEach(function (problem) {
            errors.push(problem);
        });
    }
    if (!blueprint.acceptance || !blueprint.acceptance.length) {
        errors.push({ field: 'acceptance', message: 'acceptance is missing, so success would mean only that no step errored' });
    }

    // an environment the blueprint permits but cannot size is a blueprint that
    // could never do what it says: it would publish, then fail at the first
    // submission against that environment
    const workload = blueprint.workload;
    if (!workload) {
        errors.push({
            field: 'workload',
            message: 'workload is missing, so there is no shape to deploy'
        });
    } else {
        // a setting with no default and no entry for an environment leaves
        // that environment unsized, which only shows up at submission
        ['replicas', 'cpu', 'memory'].forEach(function (setting) {
            const declared = workload[setting];
            if (declared === undefined) {
                errors.push({
                    field: 'workload.' + setting,
                    message: setting + ' is missing, so no environment can be sized'
                });
                return;
            }
            allowedEnvironments.forEach(function (environment) {
                if (settingFor(declared, environment) === undefined) {
                    errors.push({
                        field: 'workload.' + setting,
                        message: 'environment ' + environment + ' is permitted but has no '
                            + setting + ', and there is no default'
                    });
                }
            });
        });

        if (workload.replicas && workload.replicas.max !== undefined) {
            allowedEnvironments.forEach(function (environment) {
                const count = settingFor(workload.replicas, environment);
                if (count !== undefined && count > workload.replicas.max) {
                    errors.push({
                        field: 'workload.replicas',
                        message: environment + ' is sized at ' + count
                            + ' replicas, above its own max of ' + workload.replicas.max
                    });
                }
            });
        }

        if (workload.memory && workload.memory.values) {
            allowedEnvironments.forEach(function (environment) {
                const limit = (settingFor(workload.memory, environment) || {}).limits;
                if (limit !== undefined && !workload.memory.values.includes(limit)) {
                    errors.push({
                        field: 'workload.memory',
                        message: environment + ' is limited to ' + limit
                            + ', which is not one of [' + workload.memory.values.join(', ') + ']'
                    });
                }
            });
        }
    }

    (blueprint.sequence || []).forEach(function (step, i) {
        const where = 'sequence[' + i + ']';

        if (step.gate) {
            if (!step.approver_role) {
                warnings.push({
                    field: where,
                    message: 'gate ' + step.gate + ' names no approver_role, so anyone signed in could pass it'
                });
            }
            return;
        }

        if (!allowedActions.includes(step.action)) {
            errors.push({
                field: where,
                message: 'action ' + step.action + ' is not in allowed_actions [' + allowedActions.join(', ') + ']'
            });
        }
        if (!allowedEnvironments.includes(step.environment)) {
            errors.push({
                field: where,
                message: 'environment ' + step.environment + ' is not in environments [' + allowedEnvironments.join(', ') + ']'
            });
        }

        // a step carrying deployment detail is a governance document doing the
        // wrong job: replica counts belong to the resource spec
        ['spec', 'vars', 'replicas', 'image'].forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(step, key)) {
                errors.push({
                    field: where,
                    message: key + ' is deployment detail and does not belong in a blueprint'
                });
            }
        });
    });

    return { errors: errors, warnings: warnings, publishable: errors.length === 0 };
}

module.exports = { load, validate, settingFor, ROOT };
