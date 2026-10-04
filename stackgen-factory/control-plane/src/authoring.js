'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const blueprint = require('./blueprint');
const db = require('./db');
const version = require('./version');

/**
 * Authoring a blueprint.
 *
 * A draft lives only in the store, so an unfinished governance document is
 * never something the rest of the system can read. Publishing writes the file
 * and records which file it wrote, and from then on that version is frozen: the
 * next edit is a new version, derived from what the edit did.
 *
 * The version is never supplied by the author. `version.compare` reads the two
 * documents and says whether something was taken away, and that is what decides
 * the number.
 */

const DIRECTORY = 'blueprints';

function fileFor(name, root) {
    return path.join(root || blueprint.ROOT, DIRECTORY, name + '.yaml');
}

function relativeFile(name) {
    return DIRECTORY + '/' + name + '.yaml';
}

/** A name that is safe as a file name and as a reference. */
function checkName(name) {
    if (!name || !/^[a-z][a-z0-9-]{1,48}$/.test(name)) {
        throw new Error('a blueprint name must be lower case letters, digits and hyphens');
    }
    return name;
}

function rows(store, name) {
    return store.prepare(
        'SELECT * FROM blueprint WHERE name = ? ORDER BY updated_at').all(name);
}

/**
 * The published version, or null if there is none.
 *
 * A blueprint hand-written into the repository is published — it governs real
 * deployments — and has no row, because nobody used the editor to create it.
 * Falling back to the file means an edit to such a blueprint is versioned
 * against what it actually says, rather than being treated as brand new and
 * silently resetting a v3 to 1.0.0.
 */
function published(store, name, root) {
    const row = store.prepare(
        "SELECT * FROM blueprint WHERE name = ? AND state = 'published'"
        + ' ORDER BY updated_at DESC LIMIT 1').get(name);
    if (row) {
        return row;
    }

    const file = fileFor(name, root);
    if (!fs.existsSync(file)) {
        return null;
    }
    const yaml = fs.readFileSync(file, 'utf8');
    const document = YAML.parse(yaml);
    return {
        name: name,
        version: document.version || '0.0.0',
        state: 'published',
        owner_team: document.owner_team,
        visibility: document.visibility,
        yaml: yaml,
        file: relativeFile(name),
        // written by hand, so there is no author to name and saying so is
        // more honest than attributing it to whoever edits it next
        authored_by: null,
        updated_at: fs.statSync(file).mtime.toISOString(),
    };
}

function draft(store, name) {
    const row = store.prepare(
        "SELECT * FROM blueprint WHERE name = ? AND state = 'draft'").get(name);
    return row || null;
}

/**
 * Parse and validate a draft, and say what publishing it would do.
 *
 * The validation is `blueprint.validate` — the same code that decides whether a
 * published blueprint is usable. An editor with its own opinion is an editor
 * that says yes to something publishing will refuse.
 */
function review(store, name, yaml, root) {
    let document;
    try {
        document = YAML.parse(yaml);
    } catch (error) {
        return {
            parsed: null,
            validation: { publishable: false, errors: [{ field: 'yaml', message: error.message }], warnings: [] },
            next: null,
        };
    }

    if (!document || typeof document !== 'object') {
        return {
            parsed: null,
            validation: { publishable: false, errors: [{ field: 'yaml', message: 'a blueprint must be a mapping' }], warnings: [] },
            next: null,
        };
    }

    const current = published(store, name, root);
    const before = current ? YAML.parse(current.yaml) : null;

    // the author does not set the version, so their value is ignored rather
    // than validated: whatever is in the draft, the number comes from the diff
    const proposed = version.next(before, document);

    return {
        parsed: document,
        validation: blueprint.validate(Object.assign({}, document, { version: proposed.version })),
        next: proposed,
        current_version: current ? current.version : null,
    };
}

/** Save a draft. Validation does not gate saving: a draft may be incomplete. */
function saveDraft(store, name, yaml, principal, root) {
    checkName(name);
    const outcome = review(store, name, yaml, root);
    const now = new Date().toISOString();

    const existing = draft(store, name);
    if (existing) {
        store.prepare(
            'UPDATE blueprint SET yaml = ?, authored_by = ?, updated_at = ?'
            + " WHERE name = ? AND state = 'draft'"
        ).run(yaml, principal.id, now, name);
    } else {
        store.prepare(
            'INSERT INTO blueprint (name, version, state, owner_team, visibility,'
            + " yaml, file, authored_by, updated_at)"
            + " VALUES (?, ?, 'draft', ?, ?, ?, NULL, ?, ?)"
        ).run(name, 'draft', principal.team,
            (outcome.parsed && outcome.parsed.visibility) || 'shared',
            yaml, principal.id, now);
    }

    return Object.assign({ name: name, saved_at: now }, outcome);
}

/**
 * Publish a draft.
 *
 * The row and the file are written together, and the file is written first so
 * that a row can never name a file that does not exist. If the row fails, the
 * file is removed again — an orphan file would be a blueprint the loader can
 * read and the store has never heard of.
 */
function publish(store, name, principal, root) {
    const current = draft(store, name);
    if (!current) {
        throw new Error('there is no draft of ' + name + ' to publish');
    }

    const outcome = review(store, name, current.yaml, root);
    if (!outcome.validation.publishable) {
        throw new Error('this draft cannot be published: '
            + outcome.validation.errors[0].message);
    }

    // the version in the file is the derived one, never the author's
    const document = Object.assign({}, outcome.parsed, { version: outcome.next.version });
    const target = fileFor(name, root);
    const yaml = YAML.stringify(document);
    const now = new Date().toISOString();

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    fs.writeFileSync(target, yaml);

    try {
        const tx = store.transaction(function () {
            store.prepare("DELETE FROM blueprint WHERE name = ? AND state = 'draft'").run(name);
            store.prepare(
                'INSERT INTO blueprint (name, version, state, owner_team, visibility,'
                + " yaml, file, authored_by, updated_at)"
                + " VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?)"
            ).run(name, outcome.next.version, document.owner_team || principal.team,
                document.visibility || 'shared', yaml, relativeFile(name),
                principal.id, now);
        });
        tx();
    } catch (error) {
        // put the file back the way it was, so the store and the disk agree
        if (previous === null) {
            fs.rmSync(target, { force: true });
        } else {
            fs.writeFileSync(target, previous);
        }
        throw error;
    }

    return {
        name: name,
        version: outcome.next.version,
        level: outcome.next.level,
        reasons: outcome.next.reasons,
        file: relativeFile(name),
        published_at: now,
    };
}

/** Every version of a blueprint, newest first, for the history panel. */
function history(store, name, root) {
    const recorded = rows(store, name)
        .filter(function (row) { return row.state === 'published'; })
        .reverse()
        .map(function (row) {
            return {
                version: row.version, file: row.file,
                authored_by: row.authored_by, updated_at: row.updated_at,
            };
        });

    if (recorded.length) {
        return recorded;
    }

    // nothing was published through the editor, but the file may still exist
    const onDisk = published(store, name, root);
    return onDisk ? [{
        version: onDisk.version, file: onDisk.file,
        authored_by: onDisk.authored_by, updated_at: onDisk.updated_at,
    }] : [];
}

module.exports = {
    review, saveDraft, publish, draft, published, history, checkName,
    fileFor, relativeFile,
};
