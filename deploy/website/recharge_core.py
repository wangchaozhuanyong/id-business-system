"""Release the reviewed native recharge changes under the website's existing SSM lock."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import time

from remote import ADAPTER_UNIT, FORMAL, GATEWAY, PINNED_UPSTREAM, ROOT, ReleaseError, digest, identity, inspect
from remote import check_baseline, require, require_main, require_native_idle, run, snapshot, write_new
from vendure_admission import ADMISSION, SQLITE_FILENAME, STATE, WORKER_LAUNCHER, WORKER_UNIT
from vendure_admission import read_idle_queue, ready_socket, worker_binding, worker_runtime

NATIVE_UNIT = "id-business-independent-recharge-native.service"
UPSTREAM = "https://github.com/wangchaozhuanyong/codexdaichong.git"
CORE = "deploy/recharge-core"
NATIVE_CHECKS = {"card_plan_mysql_transactions_passed", "source_203_native", "source_203_adapter",
                 "customer_cards_denied", "proxy_type_batch_import_and_edit", "no_payment_or_activation_requests",
                 "owned_temporary_containers_removed"}


def worker_launch_binding():
    state, launcher_hash = worker_binding()
    commands = re.findall(rb"argv\[\]=([^;]+)", state)
    require(len(commands) == 1 and str(WORKER_LAUNCHER).encode() in commands[0],
            "worker_launch_binding_mismatch")
    return commands[0].strip(), launcher_hash


def stage_worker_launcher(content, previous, source):
    old_path = Path(previous)
    require(old_path.is_absolute() and old_path != ROOT and ROOT in old_path.parents, "worker_source_outside_project")
    old_revision = old_path.parent.name if old_path.name == "source" else ""
    revisions = re.findall(r"(?m)^sha=([0-9a-f]{40})$", content)
    rewritten = False
    if re.fullmatch(r"[0-9a-f]{40}", old_revision) and revisions == [old_revision]:
        content = content.replace("sha=" + old_revision, "sha=" + source.parent.name, 1)
        rewritten = True
    if previous in content:
        require(content.count(previous) == 1, "worker_source_reference_ambiguous")
        content = content.replace(previous, str(source), 1)
        rewritten = True
    elif old_path == ROOT / "releases" / old_revision / "source" and not rewritten:
        suffix = f"/releases/{old_revision}/source"
        if content.count(suffix) == 1:
            content = content.replace(suffix, f"/releases/{source.parent.name}/source", 1)
            rewritten = True
    if not rewritten:
        mounts = list(re.finditer(r'--mount[ \t]+"type=bind,src=([^,\n]+),dst=/app,readonly"', content))
        if len(mounts) == 1:
            start, end = mounts[0].span(1)
            content = content[:start] + str(source) + content[end:]
            rewritten = True
    require(rewritten, "worker_source_launcher_mismatch")
    return content


def stage_override(unit, filename, command, operations):
    dropin = Path("/etc/systemd/system") / (unit + ".d") / filename
    dropin.parent.mkdir(mode=0o755, exist_ok=True)
    stat = dropin.parent.lstat()
    require(dropin.parent.is_dir() and not dropin.parent.is_symlink() and
            stat.st_uid == 0 and stat.st_mode & 0o022 == 0, "recharge_unit_override_directory_mismatch")
    require(not dropin.is_symlink(), "recharge_unit_override_symlink")
    if dropin.exists():
        write_new(operations / (unit + ".before.conf"), dropin.read_text(), 0o600)
    pending = dropin.with_name("." + filename + "." + operations.parent.name[:12])
    write_new(pending, "[Service]\nExecStart=\nExecStart=" + command + "\n", 0o644)
    return pending, dropin


def ready_native(sha, image, expected_mounts):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        try:
            container = inspect("recharge-native")
            state = identity(container)
            if state["running"] and state["revision"] == sha and state["image"] == image:
                require(container["NetworkSettings"]["Ports"].get("3000/tcp") ==
                        [{"HostIp": "127.0.0.1", "HostPort": "44579"}], "native_public_binding_changed")
                require(media_mounts(container) == expected_mounts, "native_media_mounts_changed")
                health = json.loads(run(["docker", "exec", state["id"], "node",
                                         "/candidate/" + CORE + "/health.mjs"], timeout=12))
                if health.get("ready") is True:
                    script = ('import {verifyCodexdaichongSource} from "/candidate/modules/recharge/codexdaichong/prepare.mjs";'
                              'console.log(JSON.stringify(await verifyCodexdaichongSource("/candidate/.runtime/codexdaichong")));')
                    sources = json.loads(run(["docker", "exec", state["id"], "node", "--input-type=module",
                                              "-e", script], timeout=30))
                    require(sources.get("revision") == PINNED_UPSTREAM and sources.get("files") == 203 and
                            sources.get("originalFiles") == 198, "running_native_sources_mismatch")
                    return state
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(1)
    raise ReleaseError("new_native_runtime_not_ready")


def media_mounts(container):
    observed = {(m["Source"], m["Destination"], m["RW"]) for m in container["Mounts"]}
    expected = {(str(FORMAL / "recharge-data" / name), "/candidate/.runtime/codexdaichong/" + name, True)
                for name in ("debug_screenshots", "product_files", "data")}
    expected.add((str(FORMAL / "recharge-data/data"), "/app/data", True))
    require(expected <= observed, "private_recharge_media_mounts_missing")
    return observed


def verify_snapshot_receipt(sha, summary):
    folder = ROOT / "backups" / ("recharge-core-" + sha)
    manifest = folder / "manifest.json"
    ciphertext = folder / "mysql.sql.aes256gcm"
    require(summary.get("backup") == str(folder) and summary.get("verified") is True and
            type(summary.get("plainBytes")) is int and summary["plainBytes"] > 0 and
            folder.is_dir() and not folder.is_symlink() and
            all(file.is_file() and not file.is_symlink() for file in (manifest, ciphertext)),
            "sealed_recharge_backup_receipt_invalid")
    data = json.loads(manifest.read_text())
    require(data.get("revision") == sha and data.get("encrypted") is True and data.get("verified") is True and
            data.get("database") == "id_redesign_codexdaichong_prod" and
            data.get("plainBytes") == summary["plainBytes"] and
            re.fullmatch(r"[a-f0-9]{64}", data.get("plainSha256", "")) and
            re.fullmatch(r"[a-f0-9]{64}", data.get("cipherSha256", "")) and ciphertext.stat().st_size > 0,
            "sealed_recharge_backup_not_verified")
    return {"plainBytes": data["plainBytes"], "cipherSha256": data["cipherSha256"]}


class CoreRelease:
    def __init__(self, plan, source, operations):
        self.sha = plan["sha"]
        self.before = plan["before"]
        self.source = source
        self.ops = operations
        self.scripts = source / CORE
        self.native_name = "id-business-independent-recharge-native"
        self.marker = ADMISSION / "accept-submissions"
        self.paused = ADMISSION / (".recharge-core-pause-" + self.sha)
        self.worker_stopped = False
        self.switched = False
        self.receipt = {}

    def production_readback(self, *flags):
        credential = runpy.run_path(str(self.scripts / "snapshot.py"))["credential"]
        sealed = "\n".join(credential(name) for name in ("independent-mysql-app", "independent-recharge-bridge")) + "\n"
        script = (self.scripts / "check-provider-cutover.mjs").read_text()
        command = ["docker", "exec", "-i", self.native_name, "node", "--input-type=module", "-e", script, "--", *flags]
        result = subprocess.run(command, input=sealed.encode(), capture_output=True, timeout=35)
        require(result.returncode == 0, "recharge_production_readonly_preflight_failed")
        state = json.loads(result.stdout)
        require(state.get("readOnly") is True and type(state.get("providerActive")) is bool and
                all(type(state.get(key)) is int and state[key] >= 0
                    for key in ("providerInFlight", "providerUnresolved", "availableCards")),
                "recharge_production_readonly_receipt_invalid")
        return state

    def build_and_check(self):
        tag = "id-business-independent-recharge:" + self.sha
        build = self.source.parent / "native-build"
        for name in ("source", "upstream", "engine"):
            (build / name).mkdir(parents=True, mode=0o755)
        archive = self.source.parent / "artifacts" / f"independent-source-{self.sha}.tar.gz"
        run(["tar", "-xzf", str(archive), "-C", str(build / "source")])
        upstream = build / "upstream"
        git = ["git", "-c", "credential.helper=", "-C", str(upstream)]
        run([*git, "init", "--quiet"])
        run([*git, "fetch", "--quiet", "--depth=1", "--no-tags", UPSTREAM, PINNED_UPSTREAM], timeout=65)
        require(run([*git, "rev-parse", "FETCH_HEAD"]).decode().strip() == PINNED_UPSTREAM,
                "native_build_upstream_revision_mismatch")
        run([*git, "checkout", "--quiet", "--detach", PINNED_UPSTREAM])
        engine = build / "engine"
        run([*git, "archive", "--format=tar", "--output", str(build / "upstream.tar"), PINNED_UPSTREAM])
        run(["tar", "-xf", str(build / "upstream.tar"), "-C", str(engine)])
        write_new(engine / ".id-business-integrated-runtime", PINNED_UPSTREAM + "\n", 0o644)
        write_new(engine / ".id-business-production-guard", "3\n", 0o644)
        solver = run(["docker", "exec", self.native_name, "python3", "-c",
                      'import importlib.util; print(int(importlib.util.find_spec("playwright") is not None))']).decode().strip()
        require(solver in ("0", "1"), "live_python_solver_configuration_unknown")
        print("Building the exact main native recharge image", flush=True)
        run(["docker", "build", "--file", str(self.scripts / "Dockerfile"), "--tag", tag,
             "--build-arg", "BUILD_HCAPTCHA_SOLVER=" + solver, "--label", "org.opencontainers.image.revision=" + self.sha,
             "--label", "org.id-business.upstream.revision=" + PINNED_UPSTREAM, str(build)], timeout=520)
        image = json.loads(run(["docker", "image", "inspect", tag]))[0]
        image_id = image["Id"]
        labels = image["Config"]["Labels"]
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", image_id) and
                labels.get("org.opencontainers.image.revision") == self.sha and
                labels.get("org.id-business.upstream.revision") == PINNED_UPSTREAM, "native_build_image_identity_mismatch")
        canary = subprocess.run(["python3", str(self.scripts / "canary.py"), self.sha],
                                capture_output=True, timeout=295)
        if canary.returncode:
            try:
                reason = json.loads(canary.stdout.splitlines()[-1]).get("reason", "")
            except (IndexError, ValueError):
                reason = ""
            raise ReleaseError("native_canary_failed" + (": " + reason if re.fullmatch(r"[a-z0-9_]+", reason) else ""))
        receipt = json.loads((self.ops / "native-canary.receipt.json").read_text())
        require(receipt["mainSha"] == self.sha and receipt["productionWrites"] is False and
                NATIVE_CHECKS <= set(receipt["checks"]), "native_canary_receipt_mismatch")
        return image_id

    def stage_units(self):
        native = inspect("recharge-native")
        require(identity(native) == self.before["components"]["recharge-native"], "native_baseline_changed")
        previous = self.before["components"]["recharge-native"]["revision"]
        command = run(["systemctl", "show", "-p", "ExecStart", "--value", NATIVE_UNIT]).decode()
        require(re.search(r"/run-recharge\.py native " + previous + r"(?=[ ;}]|$)", command),
                "native_unit_launcher_mismatch")
        mounts = media_mounts(native)
        ready_socket()
        worker = worker_runtime(inspect("vendure-worker"))
        binding, launcher_hash = worker_launch_binding()
        require(digest(WORKER_LAUNCHER) == launcher_hash,
                "worker_launch_binding_mismatch")
        launcher_folder = WORKER_LAUNCHER.parent.lstat()
        require(not WORKER_LAUNCHER.is_symlink() and not WORKER_LAUNCHER.parent.is_symlink() and
                launcher_folder.st_uid == 0 and launcher_folder.st_mode & 0o022 == 0,
                "worker_launch_directory_mismatch")
        staged = WORKER_LAUNCHER.with_name("run-vendure-worker-" + self.sha)
        write_new(staged, stage_worker_launcher(WORKER_LAUNCHER.read_text(), worker[2], self.source), 0o700)
        run(["bash", "-n", str(staged)])
        native_unit = stage_override(NATIVE_UNIT, "99-id-managed-native-release.conf",
            f"/usr/bin/python3 {self.scripts / 'run-recharge.py'} native {self.sha}", self.ops)
        worker_unit = stage_override(WORKER_UNIT, "99-id-managed-worker-release.conf", f"/bin/bash {staged}", self.ops)
        return mounts, worker, (binding, launcher_hash), native_unit, worker_unit

    def set_gate(self, action):
        result = json.loads(run(["python3", str(self.scripts / "release-gate.py"), action, self.sha], timeout=50))
        require(result["revision"] == self.sha and result["gate"] == action + "d" and
                result["routesVerified"] == 3, "recharge_ingress_gate_readback_mismatch")
        return result["sourceSha256"]

    def pause_intake(self):
        require(not os.path.lexists(self.paused), "storefront_pause_marker_already_exists")
        if os.path.lexists(self.marker):
            stat = self.marker.lstat()
            require(self.marker.is_file() and not self.marker.is_symlink() and stat.st_uid == 993 and
                    stat.st_mode & 0o777 == 0o600, "storefront_acceptance_marker_invalid")
            self.marker.rename(self.paused)
        self.gated_digest = self.set_gate("enable")
        self.gated_gateway = identity(inspect("caddy"))

    def drain_worker(self):
        queue = STATE / SQLITE_FILENAME
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            try:
                read_idle_queue(queue)
                break
            except ReleaseError:
                time.sleep(3)
        else:
            raise ReleaseError("storefront_recharge_queue_not_idle")
        self.worker_stopped = True
        run(["systemctl", "stop", WORKER_UNIT], timeout=50)
        read_idle_queue(queue)
        require_native_idle()

    def reopen(self):
        if "# BEGIN ID CORE RELEASE " + self.sha in GATEWAY.read_text():
            self.set_gate("disable")
        require(digest(GATEWAY) == self.before["gatewaySha256"], "recharge_ingress_original_config_not_restored")
        if self.paused.exists():
            os.link(self.paused, self.marker)
            self.paused.unlink()

    def prepare(self):
        state = self.production_readback("--routes")
        print(json.dumps({"rechargePreflight": state}, sort_keys=True), flush=True)
        require(not state["providerUnresolved"], "third_party_recharge_orders_awaiting_review")
        if state["providerActive"]:
            require(all(state["routes"].values()) and len(state["routes"]) == 4,
                    "native_recharge_routes_not_ready_for_provider_retirement")
        self.image = self.build_and_check()
        self.state = state

    @contextmanager
    def cutover(self):
        check_baseline(snapshot(True), self.before)
        mounts, worker, binding, native_unit, worker_unit = self.stage_units()
        require_main(self.sha)
        try:
            self.pause_intake()
            self.drain_worker()
            require(worker_launch_binding() == binding, "storefront_worker_binding_changed_during_drain")
            drained = self.production_readback("--require-idle")
            require(drained["providerActive"] == self.state["providerActive"] and
                    drained["providerInFlight"] == 0 and drained["providerUnresolved"] == 0 and
                    (not drained["providerActive"] or drained["availableCards"] > 0), "native_recharge_cutover_not_ready")
            backup = json.loads(run(["python3", str(self.scripts / "snapshot.py"), self.sha], timeout=90))
            backup_evidence = verify_snapshot_receipt(self.sha, backup)
            require_main(self.sha)
            self.switched = True
            print("Switching the drained native recharge runtime", flush=True)
            run(["systemctl", "stop", ADAPTER_UNIT, NATIVE_UNIT], timeout=65)
            os.replace(*native_unit)
            os.replace(*worker_unit)
            run(["systemctl", "daemon-reload"])
            run(["systemctl", "start", NATIVE_UNIT], timeout=50)
            native = ready_native(self.sha, self.image, mounts)
            self.receipt = {"native": native, "nativeCanaryPassed": True, "encryptedSnapshotVerified": True,
                            "encryptedSnapshot": backup_evidence, "providerBefore": drained,
                            "routesBefore": self.state["routes"]}
            self.worker_expected = (worker[0], worker[1], str(self.source))
            yield native
        finally:
            if not self.switched:
                if self.worker_stopped:
                    run(["systemctl", "start", WORKER_UNIT], timeout=45)
                self.reopen()

    def finish(self):
        queue = STATE / SQLITE_FILENAME
        baseline, count = read_idle_queue(queue)
        run(["systemctl", "start", WORKER_UNIT], timeout=45)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                worker = inspect("vendure-worker")
                if worker_runtime(worker) == self.worker_expected:
                    revision, retained = read_idle_queue(queue)
                    require(retained == count, "storefront_recharge_task_count_changed")
                    if revision > baseline:
                        name = "modules/recharge/vendure/codexdaichong-worker.mjs"
                        reported = run(["docker", "exec", worker["Id"], "sha256sum", "/app/" + name]).decode().split()[0]
                        require(reported == digest(self.source / name), "storefront_worker_source_mismatch")
                        self.reopen()
                        self.receipt.update(workerSourceRevision=self.sha, workerPollingObserved=True, ingressResumed=True)
                        return
            except subprocess.CalledProcessError:
                pass
            time.sleep(1)
        raise ReleaseError("updated_storefront_worker_readback_failed")
