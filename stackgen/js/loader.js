const fs = require('fs');
const manifest = require('../../manifest.json');
const k8s = require('../../k8s_resources.json');

function findAvailableManifest(tenant, source_family) {
    return manifest.snapshots.filter(function (entry) {
        return entry.source_family === source_family && entry.tenant_id === tenant;
    });
}

function getK8sResource(snapshotIdSet, appCatalog) {
    const items = k8s.collections.reduce(function (acc, entry, ci) {
        if (snapshotIdSet[entry.snapshot_id]) {
            acc = acc.concat(entry.items.map(function (item, i) {
                item.__ref = {
                    source_file: 'k8s_resources.json',
                    locator: `/collections/${ci}/items/${i}`,
                    observed_at: snapshotIdSet[entry.snapshot_id].observed_at
                };
                return item;
            }));
        }
        return acc;
    }, []);
    return items.filter(function (entry) {
        if (entry.kind === 'Node') {
            return true; // cluster-scoped
        }
        return entry.metadata.namespace === appCatalog.namespace;
    }).reduce(function (acc, entry) {
        if (!acc[entry.kind]) {
            acc[entry.kind] = [];
        }
        acc[entry.kind].push(entry);
        return acc;
    }, {});
}

module.exports.findManifest = findAvailableManifest;
module.exports.queryDefaults = function () {
    return manifest.query_defaults
};
module.exports.asOf = function () {
    return manifest.as_of;
};
module.exports.reasoning = function () {
    return {
        'replicaset:pod': {
            stated_by: 'derived',
            rule: 'Pod ownerReferences uid matches the ReplicaSet uid',
        },
        'pod:node': {
            stated_by: 'source',
            rule: 'the Pod states its own spec.nodeName',
        },
        'node:instance': {
            stated_by: 'derived',
            rule: 'providerID last segment matched to InstanceId within tenant, account and region',
        },
        'arn:database': {
            stated_by: 'derived',
            rule: 'declared ARN matched to DBInstanceArn within this tenant and environment',
        },
        'instance:operator_team': {
            stated_by: 'source',
            rule: 'the record states the operator_team tag directly',
        },
        'catalog:application': {
            stated_by: 'source',
            rule: 'stated directly by the catalog row',
        },
        'catalog:deployment': {
            stated_by: 'source',
            rule: 'the catalog row names cluster_id, namespace and deployment_name',
        },
        'deployment:replicaset': {
            stated_by: 'derived',
            rule: 'ReplicaSet ownerReferences uid matches the Deployment uid',
        }
    };
};
module.exports.findK8S = getK8sResource;
