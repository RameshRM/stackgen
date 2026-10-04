'use strict';

const fs = require('fs');
const path = require('path');

const blueprint = require('./blueprint');
const db = require('./db');
const kustomize = require('./kustomize');

/**
 * Generate a spec's kustomize tree, for the image the run produced.
 *
 * Not at submission. A blueprint that builds has no image until the build
 * succeeds, and a tree naming an image that was never built is a record of a
 * deployment that cannot happen. So the DAG asks for the tree when it has an
 * image: after build, or — for a blueprint whose developer supplied the image —
 * before the first deploy. One path for both.
 *
 * The control plane writes the tree rather than the DAG, so the deployments
 * directory keeps one writer and one generator, in one language.
 *
 * Once per spec. The store's conditional update refuses a second generation,
 * so a retried task cannot replace a tree a deploy may already be applying.
 *
 * Returns { result: 'generated' | 'already_generated' | 'no_such_spec', ... }.
 */
function generate(options) {
    const store = options.db || db.connect(options.root);
    const specId = options.specId;
    const image = options.image;

    const recorded = db.manifests(store, specId);
    if (!recorded) {
        return { result: 'no_such_spec' };
    }

    const dir = path.join(options.root || blueprint.ROOT, 'deployments', specId);
    let files = null;

    const result = db.recordManifests(store, specId, image, options.at, function () {
        // not recursive: if a tree is already here — one written at submission
        // before this existed — it is refused rather than overwritten
        fs.mkdirSync(path.join(dir, 'kustomize'), { recursive: false });
        try {
            files = kustomize.write(Object.assign({}, recorded.options, { image: image }), dir);
        } catch (error) {
            fs.rmSync(path.join(dir, 'kustomize'), { recursive: true, force: true });
            throw error;
        }
    });

    if (result === 'already_generated') {
        // the image it was generated for, so a retry can tell its own earlier
        // success from somebody else's tree
        return { result: result, image: db.manifests(store, specId).image };
    }
    return { result: result, image: image, files: files };
}

module.exports = { generate };
