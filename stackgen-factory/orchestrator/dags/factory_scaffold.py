"""Creating the microservice, and building it.

A blueprint that says "create a microservice and deploy it" has to create
something. Until now the developer supplied an image that already existed, so
the factory only ever did the second half.

`scaffold` writes a real git repository — bare, so it can be cloned and pushed
to — with one commit holding a working Node service. `build` builds that
repository into an image and loads it into the cluster's node.

The image is tagged with the commit it was built from, and the manifests are
generated only after the build reports it — so a build that fails leaves no
manifests naming an image that does not exist, and two deployment specs of one
app never share an image.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

FACTORY_ROOT = Path(os.environ.get(
    "FACTORY_ROOT",
    Path(__file__).resolve().parents[2],
))

REPOS = FACTORY_ROOT / "var" / "repos"

# the cluster's node, where a locally built image has to be loaded because
# there is no registry to pull it from
KIND_CLUSTER = os.environ.get("KIND_CLUSTER", "factory")


def _run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, **kwargs)


def repo_path(app_name: str) -> Path:
    return REPOS / f"{app_name}.git"


def image_tag(blueprint: str, app_name: str, commit: str) -> str:
    """The blueprint, the app, and the commit the image was built from.

    The commit, not `latest`: with `latest` every deployment spec of one app
    shared an image, so a second build replaced what the first deployed. Twelve
    characters, as git abbreviates, is enough to be unique within one repository.

    A tag rather than a digest: an image loaded into a kind node has no registry
    digest to refer to it by.
    """
    return f"{blueprint}/{app_name}:{commit[:12]}"


SERVER_JS = '''\
'use strict';

// Scaffolded by the factory. Publishes evidence and makes no judgement: the
// control plane holds the criteria and the policy engine holds the rules.

const http = require('http');

const PORT = process.env.PORT || 3000;
const NAME = process.env.APP_NAME || '{app_name}';

// so a deployment can be made to breach its own acceptance criteria on demand
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);

const counts = {{ 200: 0, 500: 0 }};

http.createServer(function (req, res) {{
    if (req.url === '/metrics') {{
        res.writeHead(200, {{ 'content-type': 'text/plain; version=0.0.4' }});
        return res.end(
            '# HELP http_requests_total Requests handled, by status.\\n'
            + '# TYPE http_requests_total counter\\n'
            + 'http_requests_total{{status="200"}} ' + counts[200] + '\\n'
            + 'http_requests_total{{status="500"}} ' + counts[500] + '\\n');
    }}
    if (req.url === '/health') {{
        res.writeHead(200, {{ 'content-type': 'application/json' }});
        return res.end('{{"status":"ok"}}');
    }}
    const failing = Math.random() < FAIL_RATE;
    const status = failing ? 500 : 200;
    counts[status] += 1;
    res.writeHead(status, {{ 'content-type': 'application/json' }});
    res.end(JSON.stringify({{ app: NAME, status: failing ? 'error' : 'ok' }}));
}}).listen(PORT, function () {{
    console.log(NAME + ' listening on ' + PORT);
}});
'''

DOCKERFILE = '''\
FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE {port}
CMD ["node", "server.js"]
'''

PACKAGE_JSON = '''\
{{
  "name": "{app_name}",
  "version": "0.1.0",
  "private": true,
  "main": "server.js",
  "scripts": {{ "start": "node server.js" }}
}}
'''

README = '''\
# {app_name}

Scaffolded by the factory from blueprint `{blueprint}` for deployment spec
`{spec_id}`.

    git clone {repo}

The service answers on `{port}`:

    /           the application
    /health     readiness
    /metrics    a request counter, by status

It emits no deployment identifiers of its own. The platform attaches those when
it scrapes, from labels the deployment spec set — so this code cannot claim to
belong to a deployment it was not deployed by.
'''


def owner_of(target: Path) -> str | None:
    """Which deployment spec scaffolded this repository, if it says."""
    if not target.exists():
        return None
    marker = target / "factory-spec"
    return marker.read_text().strip() if marker.is_file() else None


def scaffold(app_name: str, spec_id: str, blueprint: str, port: int) -> dict:
    """Create the repository, once.

    Idempotent for the spec that owns it, and refused for any other. Airflow
    retries tasks, so a scaffold that errored on an existing repository made a
    single transient failure anywhere later in the run permanently unrunnable:
    the retry would die at the first step every time. A repository this spec
    already created is the work already being done.

    A repository belonging to a different spec is still refused, because that
    is a second deployment about to overwrite the first one's source.

    Bare, because the useful thing is a remote a developer can clone from and
    push to. The working tree is temporary and thrown away once committed.
    """
    target = repo_path(app_name)
    owner = owner_of(target)

    if owner == spec_id:
        head = _run(["git", "rev-parse", "HEAD"], cwd=target)
        return {
            "repo": str(target.relative_to(FACTORY_ROOT)),
            "clone": f"git clone {target}",
            "commit": head.stdout.strip(),
            "already_scaffolded": True,
        }

    if target.exists():
        raise FileExistsError(
            f"{target} belongs to {owner or 'another deployment'};"
            f" {spec_id} must not overwrite it")

    REPOS.mkdir(parents=True, exist_ok=True)
    created = _run(["git", "init", "--bare", "--initial-branch=main", str(target)])
    if created.returncode != 0:
        raise RuntimeError(f"could not create {target}: {created.stderr.strip()}")

    work = Path(tempfile.mkdtemp(prefix="scaffold-"))
    try:
        (work / "server.js").write_text(SERVER_JS.format(app_name=app_name))
        (work / "Dockerfile").write_text(DOCKERFILE.format(port=port))
        (work / "package.json").write_text(PACKAGE_JSON.format(app_name=app_name))
        (work / "README.md").write_text(README.format(
            app_name=app_name, blueprint=blueprint, spec_id=spec_id,
            repo=target, port=port))
        (work / ".gitignore").write_text("node_modules/\n")

        for args in (
            ["git", "init", "--initial-branch=main"],
            ["git", "add", "."],
            ["git", "-c", "user.email=factory@local", "-c", "user.name=factory",
             "commit", "-m", f"scaffold {app_name} for {spec_id}"],
            ["git", "remote", "add", "origin", str(target)],
            ["git", "push", "-q", "origin", "main"],
        ):
            step = _run(args, cwd=work)
            if step.returncode != 0:
                raise RuntimeError(
                    f"{' '.join(args[:2])} failed: {step.stderr.strip()[:200]}")

        sha = _run(["git", "rev-parse", "HEAD"], cwd=work).stdout.strip()

        # written last, inside the bare repository rather than in a commit: it
        # records which spec created this remote, and a developer pushing to it
        # must not be able to change that by editing a file
        (target / "factory-spec").write_text(spec_id + "\n")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return {
        "repo": str(target.relative_to(FACTORY_ROOT)),
        "clone": f"git clone {target}",
        "commit": sha,
        "files": ["server.js", "Dockerfile", "package.json", "README.md", ".gitignore"],
        "already_scaffolded": False,
    }


# How long to wait after the repository is written before building it.
#
# Standing in for a webhook. In a real factory the push is what triggers the
# build — a GitHub Action, or a post-receive hook — and the build is a reaction
# to code landing rather than the next thing in a list. This is a pause where
# that trigger belongs, so the shape of the sequence is already right when the
# trigger replaces it.
PUSH_DELAY_SECONDS = int(os.environ.get("FACTORY_PUSH_DELAY", "5"))


def build(blueprint: str, app_name: str) -> dict:
    """Build the scaffolded repository into an image the cluster can run.

    Loaded into the kind node rather than pushed, because there is no registry
    here. That is the one part of this that is specific to a local cluster; a
    real one would push and let the kubelet pull.
    """
    source = repo_path(app_name)
    if not source.exists():
        raise FileNotFoundError(
            f"{source} does not exist; nothing has been scaffolded to build")

    print(f"[factory] waiting {PUSH_DELAY_SECONDS}s for the push that would"
          f" trigger this build")
    time.sleep(PUSH_DELAY_SECONDS)

    work = Path(tempfile.mkdtemp(prefix="build-"))
    try:
        cloned = _run(["git", "clone", "-q", str(source), str(work / "src")])
        if cloned.returncode != 0:
            raise RuntimeError(f"could not clone {source}: {cloned.stderr.strip()[:200]}")

        # the commit that was cloned is the commit that is built, so it names
        # the image rather than a commit read from somewhere else
        head = _run(["git", "-C", str(work / "src"), "rev-parse", "HEAD"])
        if head.returncode != 0:
            raise RuntimeError(f"could not read the commit of {source}: {head.stderr.strip()[:200]}")
        commit = head.stdout.strip()
        tag = image_tag(blueprint, app_name, commit)

        built = _run(["docker", "build", "-t", tag, str(work / "src")])
        if built.returncode != 0:
            raise RuntimeError(f"docker build failed: {built.stderr.strip()[-400:]}")

        loaded = _run(["kind", "load", "docker-image", tag, "--name", KIND_CLUSTER])
        if loaded.returncode != 0:
            raise RuntimeError(f"could not load {tag} into the cluster:"
                               f" {loaded.stderr.strip()[-300:]}")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return {"image": tag, "commit": commit, "loaded_into": KIND_CLUSTER,
            "from": str(source.name)}
