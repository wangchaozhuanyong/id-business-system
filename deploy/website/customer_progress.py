"""Move only the auxiliary storefront collector to the reviewed release source."""

import os
import re
import shlex
from pathlib import Path

from remote import FORMAL, ROOT, digest, inspect, require, run, write_new
from vendure_admission import WORKER_UNIT, worker_binding, worker_runtime

FILES = (
    "modules/recharge/vendure/codexdaichong-worker.mjs",
    "modules/recharge/vendure/customer-progress.mjs",
    "modules/recharge/vendure/progress-stream.mjs",
    "modules/recharge/codexdaichong/progress-presentation.mjs",
)


def active_launcher(binding):
    commands = re.findall(rb"argv\[\]=([^;]+)", binding[0])
    require(len(commands) == 1, "customer_progress_worker_command_ambiguous")
    args = shlex.split(commands[0].decode().strip())
    require(len(args) == 2 and args[0] in ("/bin/bash", "/usr/bin/bash"),
            "customer_progress_worker_command_changed")
    path = Path(args[1])
    require(path.is_absolute() and ROOT in path.parents and path.name.startswith("run-vendure-worker") and
            (path.parent == FORMAL / "operations" or
             path.parent.name == "operations" and path.parent.parent.parent == ROOT / "releases"),
            "customer_progress_worker_launcher_outside_project")
    require(path.is_file() and not path.is_symlink(), "customer_progress_worker_launcher_invalid")
    return path


def check_worker_source():
    binding = worker_binding()
    active_launcher(binding)
    worker_runtime(inspect("vendure-worker"))


def stage_worker(source, operations):
    # Reuse the native release's source-mount rewriter; never invoke its native cutover.
    from recharge_core import stage_override, stage_worker_launcher

    binding = worker_binding()
    previous = active_launcher(binding)
    runtime = worker_runtime(inspect("vendure-worker"))
    launcher = operations / "run-vendure-worker"
    write_new(launcher, stage_worker_launcher(previous.read_text(), runtime[2], source), 0o700)
    run(["bash", "-n", str(launcher)])
    pending = stage_override(WORKER_UNIT, "99-id-managed-worker-release.conf", "/bin/bash " + str(launcher), operations)
    return {"binding": binding, "previous": previous, "previousHash": digest(previous),
            "launcher": launcher, "override": pending,
            "runtime": (runtime[0], runtime[1], str(source)),
            "files": {name: digest(source / name) for name in FILES}}


def activate_worker(plan):
    require(worker_binding() == plan["binding"] and digest(plan["previous"]) == plan["previousHash"],
            "customer_progress_worker_changed_before_switch")
    require(run(["systemctl", "show", "-p", "ActiveState", "--value", WORKER_UNIT]).decode().strip() == "inactive",
            "customer_progress_worker_not_drained")
    os.replace(*plan["override"])


def verify_worker(plan):
    container = inspect("vendure-worker")
    require(worker_runtime(container) == plan["runtime"], "customer_progress_worker_runtime_changed")
    for name, expected in plan["files"].items():
        actual = run(["docker", "exec", container["Id"], "sha256sum", "/app/" + name]).decode().split()[0]
        require(actual == expected, "customer_progress_worker_source_mismatch")
