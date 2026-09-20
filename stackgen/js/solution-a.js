const fs = require('fs');
const path = require('path');
const loader = require('./loader.js');

const queryDefaults = loader.queryDefaults();

function filterByEnv(environment, entries) {
    return entries.filter(function filter(entry) {
        return entry.scope.environment === environment;
    })
}

function tfEntries(tfSnapshots) {
    const result = tfSnapshots.reduce(function (acc, item) {
        const entry = Object.assign({}, item);
        if (entry.status === 'success') {
            entry.payload = tryGetPayload(entry.payload_path);
            acc.searched.push(entry);
        } else {
            acc.notSupplied.push(entry);
        }
        return acc;
    }, {
        searched: [],
        notSupplied: []
    });
    result.index = buildTfIndex(result.searched);
    return result;
}

function buildTfIndex(searched) {
    const index = {};
    searched.forEach(function (entry) {
        entry.payload.resources.forEach(function (r, i) {
            if (r.type !== 'aws_instance') {
                return;
            }
            if (!index[r.values.id]) {
                index[r.values.id] = [];
            }
            index[r.values.id].push({
                address: r.address,
                mode: r.mode,
                workspace_id: entry.scope.workspace_id,
                __ref: {
                    source_file: entry.payload_path,
                    locator: `/resources/${i}`,
                    observed_at: entry.observed_at,
                    freshness_budget_seconds: entry.freshness_budget_seconds,
                },
            });
        });
    });
    return index;
}



function classify(instance, index, searched) {
    if (searched.length === 0) {
        return {
            verdict: 'evidence_unavailable',
            reason: null,
            records: null
        };
    }
    const matches = index[instance.InstanceId] || [];
    const managed = matches.filter(function (m) {
        return m.mode === 'managed';
    });
    if (managed.length > 0) {
        return {
            verdict: 'binding_found',
            reason: null,
            records: managed
        };
    }
    if (matches.length > 0) {
        // present, but only as a data source: a read, not a management claim
        return {
            verdict: 'no_binding_found',
            reason: 'referenced_as_data_source_only',
            records: matches
        };
    }
    return {
        verdict: 'no_binding_found',
        reason: 'absent_from_supplied_state',
        records: null
    };
}

function buildLimitations(binding, tf, asOf) {
    const limitations = [];
    if (binding.verdict === 'evidence_unavailable') {
        limitations.push('no_terraform_state_supplied_for_this_scope');
        return limitations;
    }
    tf.searched.forEach(function (entry) {
        const age = (Date.parse(asOf) - Date.parse(entry.observed_at)) / 1000;
        if (age > entry.freshness_budget_seconds) {
            limitations.push('terraform_state_observed_past_its_freshness_budget');
        }
    });
    if (tf.notSupplied.length > 0) {
        limitations.push('some_terraform_workspaces_in_scope_not_supplied');
    }
    return limitations;
}

function tryGetPayload(payloadPath) {
    return require(path.join('../../', payloadPath));
}


function main(tenant, environment) {
    const awsSnapshots = filterByEnv(environment, loader.findManifest(tenant, 'aws'));
    const tfSnapshots = filterByEnv(environment, loader.findManifest(tenant, 'terraform'));

    const tf = tfEntries(tfSnapshots);
    const index = tf.index;
    const asOf = loader.asOf();
    const results = [];

    awsSnapshots.forEach(function (snapshot) {
        if (snapshot.status !== 'success') {
            return;
        }
        const payload = tryGetPayload(snapshot.payload_path);
        payload.collections.forEach(function (collection, ci) {
            if (collection.snapshot_id !== snapshot.snapshot_id) {
                return;
            }
            collection.instances.forEach(function (instance, i) {
                if (instance.State.Name !== 'running') {
                    return;
                }
                const binding = classify(instance, index, tf.searched);
                results.push({
                    instance_id: instance.InstanceId,
                    account_id: snapshot.scope.account_id,
                    region: snapshot.scope.region,
                    observed_running: {
                        state: instance.State.Name,
                        environment: snapshot.scope.environment,
                        __ref: {
                            source_file: snapshot.payload_path,
                            locator: `/collections/${ci}/instances/${i}`,
                            observed_at: snapshot.observed_at,
                        },
                    },
                    terraform_binding: binding,
                    limitations: buildLimitations(binding, tf, asOf),
                });
            });
        });
    });

    results.sort(function (a, b) {
        return a.instance_id < b.instance_id ? -1 : 1;
    });

    return {
        query: {
            tenant_id: tenant,
            environment: environment,
        },
        evaluated_at: asOf,
        results: results,
        scope: {
            terraform_workspaces_searched: tf.searched.map(function (e) {
                return e.scope.workspace_id;
            }),
            terraform_workspaces_not_supplied: tf.notSupplied.map(function (e) {
                return e.scope.workspace_id;
            }),
        },
    };
}

// main(queryDefaults.tenant_id, queryDefaults.environment);
module.exports.main = main;
