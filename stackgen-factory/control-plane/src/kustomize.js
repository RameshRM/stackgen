'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

// one definition of how a setting resolves for an environment, shared with the
// validator: two copies of this had already drifted on the no-default case
const { settingFor } = require('./blueprint');

/**
 * Generate a kustomize tree for one deployment spec.
 *
 * Nothing here is hand-written: the workload shape comes from the blueprint,
 * the values from the developer's answers. The tree belongs to one deployment
 * spec and is generated beside it, so there is no shared file for anyone to
 * edit after the fact.
 *
 * Kustomize is kept rather than rendering to a manifest here, because the
 * kustomization is the editable thing. A rendered manifest would have to be
 * changed as raw Kubernetes YAML.
 */

/**
 * The base Deployment.
 *
 * Everything protocol-specific is conditional on an answer. A blueprint that
 * does not ask for a port describes something that does not listen on one, and
 * emitting `containerPort: {}` and `PORT=undefined` for it — which is what this
 * did before — is generating YAML that is wrong rather than absent.
 */
function baseDeployment(options) {
    const workload = options.workload;
    // the base holds the defaults; overlays patch whatever differs
    const cpu = settingFor(workload.cpu, null);
    const memory = settingFor(workload.memory, null);

    const port = options.port;
    const container = {
        name: 'app',
        image: options.image,
        // Kubernetes defaults this to Always for any image tagged `latest`, so
        // it ignores an image already on the node and tries to pull one from a
        // registry. The factory builds locally and loads into the node, so
        // there is nothing to pull and the pod sits in ImagePullBackOff with
        // the image sitting right there.
        imagePullPolicy: 'IfNotPresent',
        resources: {
            requests: { cpu: cpu.requests, memory: memory.requests },
            limits: { cpu: cpu.limits, memory: memory.limits },
        },
    };

    if (port !== undefined) {
        container.ports = [{ containerPort: port }];
        container.env = [{ name: 'PORT', value: String(port) }];
    }
    if (options.health_path !== undefined && port !== undefined) {
        container.readinessProbe = {
            httpGet: { path: options.health_path, port: port },
        };
    }

    const metadata = { labels: { app: options.app_name } };

    // Discovery is by annotation, so a workload becomes observable by being
    // deployed: there is no second place to register it and therefore no second
    // place to forget. A workload that publishes nothing is not annotated, and
    // acceptance on it will say cannot_tell rather than scraping a closed port.
    if (options.metrics_path !== undefined && port !== undefined) {
        metadata.annotations = {
            'prometheus.io/scrape': 'true',
            'prometheus.io/port': String(port),
            'prometheus.io/path': options.metrics_path,
        };
    }

    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: options.app_name },
        spec: {
            // overlays set the real count per environment
            replicas: 1,
            selector: { matchLabels: { app: options.app_name } },
            template: { metadata: metadata, spec: { containers: [container] } },
        },
    };
}

/** A Service, only for something that listens. */
function baseService(options) {
    if (options.port === undefined) {
        return null;
    }
    return {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: options.app_name },
        spec: {
            selector: { app: options.app_name },
            ports: [{ port: options.port, targetPort: options.port }],
        },
    };
}

function baseKustomization(options) {
    const resources = ['deployment.yaml'];
    if (options.port !== undefined) {
        resources.push('service.yaml');
    }
    return {
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        resources: resources,
    };
}

/**
 * One overlay per environment: the namespace, the replica count, and a patch
 * for any resource value that differs from the base.
 *
 * The patch is emitted only when it changes something, so an overlay that
 * matches the default stays empty of noise.
 */
function overlay(options, environment) {
    const workload = options.workload;

    const replicas = settingFor(workload.replicas, environment);
    if (replicas === undefined) {
        throw new Error('the blueprint declares no replica count for ' + environment);
    }

    const cpu = settingFor(workload.cpu, environment);
    const memory = settingFor(workload.memory, environment);
    const baseCpu = settingFor(workload.cpu, null);
    const baseMemory = settingFor(workload.memory, null);

    const kustomization = {
        apiVersion: 'kustomize.config.k8s.io/v1beta1',
        kind: 'Kustomization',
        namespace: options.namespaces[environment],
        resources: ['../../base'],
        replicas: [{ name: options.app_name, count: replicas }],
        // includeTemplates puts these on the pod, which is what Prometheus
        // discovers; includeSelectors leaves them out of the selector, which is
        // immutable once a Deployment exists. Without the first, the labels
        // land on the Deployment alone and every metric is undimensioned.
        //
        // The dimensions reach the metric by relabelling at scrape time, not by
        // the application emitting them. An app asked to label its own metrics
        // with a spec id is an app that can forget to, and an app that can
        // claim a spec it was not deployed by.
        labels: [{
            includeSelectors: false,
            includeTemplates: true,
            pairs: {
                'factory.team': options.team,
                'factory.spec': options.spec_id,
                'factory.blueprint': options.blueprint,
            },
        }],
    };

    const differs = cpu.requests !== baseCpu.requests || cpu.limits !== baseCpu.limits
        || memory.requests !== baseMemory.requests || memory.limits !== baseMemory.limits;

    if (differs) {
        kustomization.patches = [{
            target: { kind: 'Deployment', name: options.app_name },
            patch: [
                '- op: replace',
                '  path: /spec/template/spec/containers/0/resources',
                '  value:',
                '    requests:',
                '      cpu: ' + cpu.requests,
                '      memory: ' + memory.requests,
                '    limits:',
                '      cpu: ' + cpu.limits,
                '      memory: ' + memory.limits,
            ].join('\n'),
        }];
    }

    return kustomization;
}

/** Write the tree beside the deployment spec it belongs to. */
function write(options, dir) {
    const base = path.join(dir, 'kustomize', 'base');
    fs.mkdirSync(base, { recursive: true });

    const files = {};
    files[path.join(base, 'deployment.yaml')] = baseDeployment(options);
    files[path.join(base, 'kustomization.yaml')] = baseKustomization(options);

    const service = baseService(options);
    if (service) {
        files[path.join(base, 'service.yaml')] = service;
    }

    options.environments.forEach(function (environment) {
        const overlayDir = path.join(dir, 'kustomize', 'overlays', environment);
        fs.mkdirSync(overlayDir, { recursive: true });
        files[path.join(overlayDir, 'kustomization.yaml')] = overlay(options, environment);
    });

    Object.keys(files).forEach(function (file) {
        fs.writeFileSync(file, YAML.stringify(files[file]));
    });

    return Object.keys(files).sort();
}

module.exports = { write, baseDeployment, baseService, baseKustomization, overlay };
