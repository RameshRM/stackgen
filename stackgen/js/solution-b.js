const fs = require('fs');
const path = require('path');
const loader = require('./loader.js');
const queryDefaults = loader.queryDefaults();

function main(tenant, environment, application) {
    const appCatalogues = findCatalogues(application, environment, tenant);
    const appCatalog = appCatalogues[0];
    const asOf = loader.asOf();
    const snapshots = availableManifest(tenant, 'kubernetes').filter(function (entry) {
        return entry.scope.cluster_id === appCatalog.cluster_id;
    });
    const snapshot = snapshots[0];

    if (!snapshot || snapshot.status !== 'success') {
        return {
            query: {
                tenant_id: tenant,
                environment: environment,
                application_name: application
            },
            evaluated_at: asOf,
            verdict: 'evidence_unavailable',
            reason: 'no kubernetes collection supplied for this tenant and cluster',
        };

    }

    const snapshotIds = {};
    snapshotIds[snapshot.snapshot_id] = snapshot;

    const result = getK8sResource(snapshotIds, appCatalog);
    const fd = getFD(result.Deployment, application);
    const rs = getRS(fd, result.ReplicaSet, application);
    const pods = getPod(rs[0], result.Pod, application);
    const awsInventories = getAWSInventory(tenant, environment);
    const tfStates = getTFState(tenant, environment);
    const awsDatabases = getAWSDatabases(tenant, environment);
    // pod -> node -> cloud instance
    const hops = pods.map(function (pod) {
        const node = getNodes(pod, result.Node)[0];
        const instance_id = getInstanceId(node);
        const aws_inventory = getAWSInventoryByInstance(awsInventories, instance_id);
        const tfEntry = getTFEntry(tfStates, 'operator_team', instance_id);
        const tfTeams = tfEntry && tfEntry.team ? Object.keys(tfEntry.team) : [];
        const sharedNodeWorkloads = result.Pod.filter(function (p) {
            return p.spec.nodeName === pod.spec.nodeName &&
                p.metadata.uid !== pod.metadata.uid;
        }).map(function (p) {
            return p.metadata.name;
        });

        const awsTeams = awsTeam(aws_inventory, 'operator_team');
        return {
            pod: {
                name: pod.metadata.name,
                __ref: pod.__ref,
                ...RULES['replicaset:pod'],

            },
            namespace: pod.metadata.namespace,
            node: {
                name: pod.spec.nodeName,
                __ref: node ? node.__ref : undefined,
                found: node !== undefined,
                ...RULES['pod:node'],
            },
            sharedNodeWorkloads: sharedNodeWorkloads,
            provider_id: node && node.spec ? node.spec.providerID : undefined,
            instance: {
                id: instance_id,
                __ref: aws_inventory && aws_inventory[0] ? aws_inventory[0].__ref : undefined,
                ...RULES['node:instance'],
            },
            stops_at: stopReason(pod, node),
            tf: {
                __ref: tfEntry ? tfEntry.__ref : undefined,
                ...RULES['instance:operator_team'],
            },
            team: {
                aws: awsTeams,
                tf: tfTeams,
                haveConflict: tfTeams.some(function (t) {
                    return awsTeams.indexOf(t) === -1;
                })

            }
        };
    });
    return {
        evaluated_at: asOf,
        query: {
            tenant_id: tenant,
            environment: environment,
            application_name: application
        },
        application: {
            name: appCatalog.service_id,
            __ref: appCatalog.__ref,
            ...RULES['catalog:application']
        },
        owner_team: {
            value: appCatalog.owner_team,
            ...RULES['catalog:application']
        },
        cluster: {
            value: appCatalog.cluster_id,
            ...RULES['catalog:application']
        },
        namespace: {
            value: appCatalog.namespace,
            ...RULES['catalog:application']
        },
        deployment: {
            name: fd ? fd.metadata.name : undefined,
            __ref: fd ? fd.__ref : undefined,
            ...RULES['catalog:deployment']
        },
        replicaset: {
            name: rs[0] ? rs[0].metadata.name : undefined,
            __ref: rs[0] ? rs[0].__ref : undefined,
            ...RULES['deployment:replicaset']
        },
        declared_dependencies: [
            resolveDependency(appCatalog.declared_dependency_arn, awsDatabases,
                awsInventories, tenant, environment)
        ],
        paths: hops,
    };
}

function getAWSDatabases(tenant, environment) {
    const snapshots = availableManifest(tenant, 'aws').filter(function filter(entry) {
        return entry.scope.environment === environment && entry.status === 'success';
    });
    const snapshotIdSet = snapshots.reduce(function (acc, entry) {
        acc[entry.snapshot_id] = 1;
        return acc;
    }, {});
    const resource = require('../../aws_inventory.json');
    return resource.collections.reduce(function reduce(acc, entry) {
        if (snapshotIdSet[entry.snapshot_id] !== undefined) {
            acc = acc.concat(entry.databases);
        }
        return acc;
    }, []);
}

function resolveDependency(arn, databases, instances, tenant, environment) {
    // a blank cell means the catalog supplied no dependency, not that none exists
    if (!arn) {
        return {
            arn: null,
            resolved: false,
            reason: 'not_supplied_by_catalog'
        };
    }

    const parts = arn.split(':');
    const service = parts[2];

    if (service === 'rds') {
        const matches = databases.filter(function filter(db) {
            return db.DBInstanceArn === arn;
        });
        if (matches.length === 0) {
            return {
                arn: arn,
                type: 'rds',
                resolved: false,
                reason: 'target_not_in_supplied_inventory'

            };
        }
        return {
            arn: arn,
            type: 'rds',
            resolved: true,
            db_identifier: matches[0].DBInstanceIdentifier,
            status: matches[0].DBInstanceStatus,
            ...RULES['arn:database'],
        };
    }

    if (service === 'ec2') {
        const snapshots = availableManifest(tenant, 'aws').filter(function filter(entry) {
            return entry.scope.environment === environment && entry.status === 'success';
        });
        const matches = instances.filter(function filter(inst) {
            return snapshots.some(function (snapshot) {
                const built = 'arn:aws:ec2:' + snapshot.scope.region + ':' +
                    snapshot.scope.account_id + ':instance/' + inst.InstanceId;
                return built === arn;
            });
        });
        if (matches.length === 0) {
            return {
                arn: arn,
                type: 'ec2',
                resolved: false,
                reason: 'target_not_in_supplied_inventory'
            };
        }
        return {
            arn: arn,
            type: 'ec2',
            resolved: true,
            instance_id: matches[0].InstanceId,
            status: matches[0].State.Name,
            stated_by: 'derived'
        };
    }

    return {
        arn: arn,
        type: service,
        resolved: false,
        reason: 'unsupported_dependency_type'
    };
}

function getTFEntry(tfResources, tagKey, instance_id) {

    return tfResources.reduce(function reduce(acc, entry) {
        if (entry.values && entry.values.id === instance_id && entry.values.tags) {
            acc.__ref = entry.__ref;
            acc.team[entry.values.tags[tagKey]] = 1;
        }
        return acc;
    }, {
        team: {},
        __ref: undefined
    });

}

function awsTeam(awsInventory, tagKey) {
    const tags = awsInventory.reduce(function reduce(acc, entry) {
        acc = acc.concat(entry.Tags);
        return acc;
    }, []);
    return tags.filter(function filter(entry) {
        return entry.Key === tagKey;
    }).map(function (entry) {
        return entry.Value;
    });
}

function getAWSInventoryByInstance(awsInventories, instance_id) {
    return awsInventories.filter(function filter(entry) {
        return entry.InstanceId === instance_id;
    });

}

function getTFState(tenant, environment) {
    const snapshots = availableManifest(tenant, 'terraform').filter(function filter(entry) {
        return entry.scope.environment === environment;
    });
    const tfSnapsnhot = snapshots[0];
    const resource = require(path.join('../../', tfSnapsnhot.payload_path));
    return resource.resources.map(function (item, i) {
        item.__ref = {
            source_file: tfSnapsnhot.payload_path,
            locator: `/resources/${i}`,
            observed_at: tfSnapsnhot.observed_at,
            freshness_budget_seconds: tfSnapsnhot.freshness_budget_seconds
        };
        return item;
    });
}

function getAWSInventory(tenant, environment) {
    const snapshots = availableManifest(tenant, 'aws').filter(function filter(entry) {
        return entry.scope.environment === environment;
    });
    const snapshotIdSet = snapshots.reduce(function (acc, entry) {
        acc[entry.snapshot_id] = entry;
        return acc;
    }, {});
    const resource = require('../../aws_inventory.json');
    return resource.collections.reduce(function reduce(acc, entry, ci) {
        if (snapshotIdSet[entry.snapshot_id] !== undefined) {
            acc = acc.concat(entry.instances.map(function (item, i) {
                item.__ref = {
                    source_file: 'aws_inventory.json',
                    locator: `/collections/${ci}/instances/${i}`,
                    observed_at: snapshotIdSet[entry.snapshot_id].observed_at,
                    freshness_budget_seconds: snapshotIdSet[entry.snapshot_id].freshness_budget_seconds

                };

                return item;
            }));
        }
        return acc;
    }, []);
}


function getInstanceId(node) {
    // providerID is optional; an omitted one is not an empty instance id
    if (!node || !node.spec || !node.spec.providerID) {
        return undefined;
    }
    const parts = node.spec.providerID.split('/');
    return parts[parts.length - 1];
}

function stopReason(pod, node) {
    if (!node) {
        return 'node_not_in_supplied_collection';
    }
    if (!node.spec || !node.spec.providerID) {
        return 'node_has_no_provider_reference';
    }
    return null;
}

function getNodes(pod, nodes) {
    return nodes.filter(function (node) {
        return node.metadata.name === pod.spec.nodeName;
    });
}

function getDeclaredCatalogues() {
    return loadcsv(path.join(__dirname, '../../', 'service_catalog.csv'));
}

function findCatalogues(serviceName, environment, tenant) {
    const manifest = availableManifest(tenant, 'catalog');
    const allowed = manifest.reduce(function (acc, entry) {
        if (entry.status === 'success') {
            acc[entry.snapshot_id] = entry;
        }
        return acc;
    }, {});

    return getDeclaredCatalogues().filter(function (entry) {
        return allowed[entry.snapshot_id] !== undefined &&
            entry.service_name === serviceName &&
            entry.environment === environment;
    }).map(function (entry) {
        entry.__ref.observed_at = allowed[entry.snapshot_id].observed_at;
        return entry;
    });
}

function loadcsv(fileName) {
    const lines = fs.readFileSync(fileName).toString().split('\n');
    const header = lines[0].trim().split(',');
    const catalogues = [];
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '') {
            continue;
        }
        const cols = lines[i].trim().split(',');
        const catalogue = {};
        for (let j = 0; j < header.length; j++) {
            // a blank cell means not supplied, never an empty claim
            catalogue[header[j]] = (cols[j] || '') === '' ? null : cols[j];
        }
        catalogue.__ref = {
            source_file: 'service_catalog.csv',
            locator: `row=${i + 1}`
        };
        catalogues.push(catalogue);
    }
    return catalogues;
}


function availableManifest(tenant, source_family) {
    return loader.findManifest(tenant, source_family);
}

function getFD(deployments, serviceName) {
    const selected = deployments.filter(function (entry) {
        return entry.spec.selector.matchLabels.app === serviceName;
    });
    return selected.length > 0 ? selected[0] : undefined;
}

function getRS(fd, replicas, serviceName) {
    return replicas.filter(function (rs) {
        return rs.spec.selector.matchLabels.app === serviceName &&
            hasOwnerRef(rs.metadata.ownerReferences, fd.metadata.uid);
    });
}

function getPod(rs, pods, serviceName) {
    return pods.filter(function (pod) {
        return pod.metadata.labels.app === serviceName &&
            hasOwnerRef(pod.metadata.ownerReferences, rs.metadata.uid);
    });
}

function hasOwnerRef(ownerReferences, parentUid) {
    for (let i = 0; i < ownerReferences.length; i++) {
        if (ownerReferences[i].uid === parentUid) {
            return true;
        }
    }
    return false;
}

function getK8sResource(snapshotIdSet, appCatalog) {
    return loader.findK8S(snapshotIdSet, appCatalog);
}

const RULES = loader.reasoning();
// main(queryDefaults.tenant_id, queryDefaults.environment, queryDefaults.application_name);

module.exports.main = main;
