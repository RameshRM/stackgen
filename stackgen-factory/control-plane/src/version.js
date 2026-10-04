'use strict';

/**
 * What an edit to a blueprint did, and therefore what its next version is.
 *
 * The version is derived, never chosen. A number the author picks from a
 * dropdown records what they believed; a number derived from the change records
 * what the change was, and a developer reading `v2.0.0` can trust that
 * something they were allowed to do is no longer allowed.
 *
 * The three levels are about permission, not about size:
 *
 *   major  something permitted no longer is, or something new is required
 *   minor  something newly permitted, and nothing taken away
 *   patch  neither: the same operations, on the same terms
 *
 * Adding a gate is major. It takes nothing away from the cluster, but a
 * developer who could deploy to production unattended now cannot, and finding
 * that out at submission time is exactly what a version is meant to prevent.
 */

function parse(version) {
    const parts = String(version === undefined || version === null ? '0.0.0' : version)
        .split('.');
    const numbers = [0, 1, 2].map(function (i) {
        const value = Number(parts[i]);
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    });
    return { major: numbers[0], minor: numbers[1], patch: numbers[2] };
}

function format(parsed) {
    return parsed.major + '.' + parsed.minor + '.' + parsed.patch;
}

function bump(version, level) {
    const current = parse(version);
    if (level === 'major') {
        return format({ major: current.major + 1, minor: 0, patch: 0 });
    }
    if (level === 'minor') {
        return format({ major: current.major, minor: current.minor + 1, patch: 0 });
    }
    return format({ major: current.major, minor: current.minor, patch: current.patch + 1 });
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function removed(before, after) {
    return list(before).filter(function (item) { return !list(after).includes(item); });
}

function added(before, after) {
    return list(after).filter(function (item) { return !list(before).includes(item); });
}

function boundaries(blueprint) {
    return blueprint.boundaries || {};
}

function questionsById(blueprint) {
    const out = {};
    list(blueprint.questions).forEach(function (question) {
        out[question.id] = question;
    });
    return out;
}

function gates(blueprint) {
    return list(blueprint.sequence)
        .filter(function (step) { return step.gate; })
        .map(function (step) { return step.gate; });
}

function steps(blueprint) {
    return list(blueprint.sequence)
        .filter(function (step) { return step.action; })
        .map(function (step) { return step.action + ':' + step.environment; });
}

/** Every overridable setting's bound, flattened so it can be compared. */
function bounds(blueprint) {
    const workload = blueprint.workload || {};
    const out = {};
    Object.keys(workload).forEach(function (name) {
        const setting = workload[name];
        if (!setting || typeof setting !== 'object') {
            return;
        }
        if (setting.max !== undefined) {
            out[name + '.max'] = setting.max;
        }
        if (Array.isArray(setting.values)) {
            out[name + '.values'] = setting.values;
        }
    });
    return out;
}

/**
 * Compare two blueprints and say what changed and how far the version moves.
 *
 * Returns { level, reasons }. `reasons` is what the editor shows the author
 * before they publish, because "this is 2.0.0" is only useful with the sentence
 * that made it so.
 */
function compare(before, after) {
    const majors = [];
    const minors = [];

    // ---- what may be done, and where
    removed(boundaries(before).allowed_actions, boundaries(after).allowed_actions)
        .forEach(function (action) {
            majors.push(action + ' is no longer an allowed action');
        });
    added(boundaries(before).allowed_actions, boundaries(after).allowed_actions)
        .forEach(function (action) {
            minors.push(action + ' is now an allowed action');
        });
    removed(boundaries(before).environments, boundaries(after).environments)
        .forEach(function (environment) {
            majors.push(environment + ' is no longer an allowed environment');
        });
    added(boundaries(before).environments, boundaries(after).environments)
        .forEach(function (environment) {
            minors.push(environment + ' is now an allowed environment');
        });

    // ---- what is asked of the developer
    const askedBefore = questionsById(before);
    const askedAfter = questionsById(after);

    Object.keys(askedAfter).forEach(function (id) {
        if (askedBefore[id]) {
            return;
        }
        if (askedAfter[id].default === undefined) {
            // a submission that was complete yesterday is incomplete today
            majors.push(id + ' is a new question with no default, so it must be answered');
        } else {
            minors.push(id + ' is a new question, defaulted to ' + askedAfter[id].default);
        }
    });
    Object.keys(askedBefore).forEach(function (id) {
        if (!askedAfter[id]) {
            minors.push(id + ' is no longer asked');
        } else if (askedBefore[id].type !== askedAfter[id].type) {
            majors.push(id + ' changed type from ' + askedBefore[id].type
                + ' to ' + askedAfter[id].type);
        } else if (askedBefore[id].default !== undefined
                && askedAfter[id].default === undefined) {
            majors.push(id + ' lost its default, so it must now be answered');
        }
    });

    // ---- the room a developer has to choose
    const boundsBefore = bounds(before);
    const boundsAfter = bounds(after);

    Object.keys(boundsBefore).forEach(function (key) {
        const was = boundsBefore[key];
        const now = boundsAfter[key];

        if (now === undefined) {
            majors.push(key + ' is gone, so that setting can no longer be overridden');
            return;
        }
        if (Array.isArray(was)) {
            removed(was, now).forEach(function (value) {
                majors.push(value + ' is no longer permitted for ' + key.split('.')[0]);
            });
            added(was, now).forEach(function (value) {
                minors.push(value + ' is now permitted for ' + key.split('.')[0]);
            });
            return;
        }
        if (now < was) {
            majors.push(key + ' fell from ' + was + ' to ' + now);
        } else if (now > was) {
            minors.push(key + ' rose from ' + was + ' to ' + now);
        }
    });
    Object.keys(boundsAfter).forEach(function (key) {
        if (boundsBefore[key] === undefined) {
            minors.push(key.split('.')[0] + ' can now be overridden, within ' + key.split('.')[1]);
        }
    });

    // ---- who has to agree
    removed(gates(before), gates(after)).forEach(function (gate) {
        minors.push('the ' + gate + ' gate is gone, so nobody has to approve it');
    });
    added(gates(before), gates(after)).forEach(function (gate) {
        // nothing is taken from the cluster, but a developer who could reach
        // production unattended now waits for a person
        majors.push('a new gate, ' + gate + ', must now be passed');
    });

    // ---- what actually happens
    removed(steps(before), steps(after)).forEach(function (step) {
        majors.push(step.replace(':', ' to ') + ' no longer happens');
    });
    added(steps(before), steps(after)).forEach(function (step) {
        minors.push(step.replace(':', ' to ') + ' now happens');
    });

    if (majors.length) {
        return { level: 'major', reasons: majors.concat(minors) };
    }
    if (minors.length) {
        return { level: 'minor', reasons: minors };
    }
    return { level: 'patch', reasons: ['nothing changed about what may happen'] };
}

/**
 * The version a draft would be published as.
 *
 * A first publish is 1.0.0 and is not compared against anything: there is no
 * earlier version to have taken something away from.
 */
function next(before, after) {
    if (!before) {
        return { version: '1.0.0', level: 'major', reasons: ['a new blueprint'] };
    }
    const change = compare(before, after);
    return {
        version: bump(before.version, change.level),
        level: change.level,
        reasons: change.reasons,
    };
}

module.exports = { parse, format, bump, compare, next };
