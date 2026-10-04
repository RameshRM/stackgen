'use strict';

/**
 * A sequence is a graph, not a list.
 *
 * It used to be a list: every step depended on the one before it, so the only
 * shape it could describe was a line. Real operations fork — scan and load-test
 * the same deployment at once, join before the gate — and an orchestrator that
 * can only draw a line is not showing you your operation.
 *
 * Dependencies are named with `needs`. A step with no `needs` depends on the one
 * before it, which is what makes every blueprint written against the old list
 * keep meaning exactly what it meant.
 *
 * Nothing here executes anything. It resolves ids, works out what depends on
 * what, and refuses a graph that cannot run — a cycle, or a dependency on a step
 * that does not exist. Those have to be refused when a blueprint is published,
 * not discovered when Airflow fails to parse.
 */

/**
 * The id of a step, given or derived.
 *
 * Derived so that a blueprint need not name steps it never refers to. The
 * derivation is stable — the same step always derives the same id — because
 * these end up as Airflow task ids and a task that changes name between parses
 * loses its history.
 */
function idFor(step, index) {
    if (step.id) {
        return String(step.id);
    }
    if (step.gate) {
        return 'gate_' + step.gate;
    }
    if (step.action && step.environment) {
        return step.action + '_' + step.environment;
    }
    return 'step_' + (index + 1);
}

/**
 * Every step with its id and the ids it waits for.
 *
 * `needs` absent means the previous step. `needs: []` means a root, which is how
 * a step says it waits for nothing rather than accidentally inheriting an order
 * it did not ask for.
 */
function resolveGraph(sequence) {
    const steps = (sequence || []).map(function (step, index) {
        return Object.assign({}, step, { id: idFor(step, index) });
    });

    return steps.map(function (step, index) {
        let needs;
        if (Array.isArray(step.needs)) {
            needs = step.needs.map(String);
        } else if (step.needs !== undefined) {
            needs = [String(step.needs)];
        } else {
            needs = index === 0 ? [] : [steps[index - 1].id];
        }
        return Object.assign({}, step, { needs: needs });
    });
}

/** The ids on a path that returns to where it started, or null if there is none. */
function findCycle(graph) {
    const byId = {};
    graph.forEach(function (step) { byId[step.id] = step; });

    const state = {};              // unvisited | open | done
    const path = [];

    function walk(id) {
        if (state[id] === 'done') {
            return null;
        }
        if (state[id] === 'open') {
            // the cycle is the path from where this id first appeared
            return path.slice(path.indexOf(id)).concat(id);
        }

        state[id] = 'open';
        path.push(id);

        const step = byId[id];
        const needs = step ? step.needs : [];
        for (let i = 0; i < needs.length; i += 1) {
            const found = walk(needs[i]);
            if (found) {
                return found;
            }
        }

        path.pop();
        state[id] = 'done';
        return null;
    }

    for (let i = 0; i < graph.length; i += 1) {
        const found = walk(graph[i].id);
        if (found) {
            return found;
        }
    }
    return null;
}

/**
 * What is wrong with this sequence as a graph.
 *
 * Every one of these makes the blueprint unrunnable, so they are errors rather
 * than warnings: a duplicate id means two steps answer to one name, a dangling
 * `needs` means a step waits for something that will never happen, and a cycle
 * means nothing can start.
 */
function problems(sequence) {
    const found = [];
    const graph = resolveGraph(sequence);

    const seen = {};
    graph.forEach(function (step) {
        if (seen[step.id]) {
            found.push({
                field: 'sequence',
                message: 'two steps are both called ' + step.id
                    + '; give one of them its own id',
            });
        }
        seen[step.id] = true;
    });

    graph.forEach(function (step) {
        step.needs.forEach(function (need) {
            if (!seen[need]) {
                found.push({
                    field: 'sequence',
                    message: step.id + ' needs ' + need + ', which is not a step in this sequence',
                });
            }
        });
    });

    // a cycle among dangling ids is not worth reporting twice
    if (!found.length) {
        const cycle = findCycle(graph);
        if (cycle) {
            found.push({
                field: 'sequence',
                // written in the direction of waiting, so it reads as a
                // sentence: a waits for c, which waits for b, which waits for a
                message: 'these steps wait for each other and none can start: '
                    + cycle.join(' waits for '),
            });
        }
    }

    return found;
}

/** Steps in an order where nothing comes before what it needs. */
function inOrder(sequence) {
    const graph = resolveGraph(sequence);
    const byId = {};
    graph.forEach(function (step) { byId[step.id] = step; });

    const out = [];
    const placed = {};

    function place(id) {
        if (placed[id] || !byId[id]) {
            return;
        }
        placed[id] = true;                 // set first: a cycle must not recurse forever
        byId[id].needs.forEach(place);
        out.push(byId[id]);
    }

    graph.forEach(function (step) { place(step.id); });
    return out;
}

module.exports = { idFor, resolveGraph, problems, findCycle, inOrder };
