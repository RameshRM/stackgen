'use strict';

/**
 * The name of the run that realises a deployment spec.
 *
 * One DAG per spec, holding the whole sequence. An earlier version split the
 * sequence at every gate into a DAG each, so that waiting for a person did not
 * hold a worker — but Airflow already solves that with a sensor in reschedule
 * mode, which releases its worker between pokes. Splitting bought nothing and
 * cost the thing Airflow is for: a graph of the actual chain, end to end.
 *
 * The sequence needs no plan beyond itself. It already says what happens, in
 * order, with the gates in place; the DAG factory walks it.
 */

/**
 * A dag id from a spec id.
 *
 * Hyphens become underscores because the factory assigns these into `globals()`
 * and a dag id has to be a usable Python identifier. That mapping is why two
 * spec ids can collide on one dag id, and why the store holds it unique.
 */
function dagId(specId) {
    return specId.replace(/-/g, '_');
}

module.exports = { dagId };
