"""Finish a verified interrupted switch while keeping its running native container."""

from contextlib import contextmanager
import hashlib
import json
import os
import re
import runpy
import shlex
import stat

from recharge_core import CoreRelease, NATIVE_CHECKS, NATIVE_UNIT, media_mounts
from recharge_core import ready_native, stage_worker_launcher, verify_snapshot_receipt
from remote import ADAPTER_DROP, ADAPTER_UNIT, FORMAL, GATEWAY, ROOT, ContainerMetadataError
from remote import digest, identity, inspect, native_publication_state, require, require_main, require_native_idle, run
from vendure_admission import GID, SQLITE_FILENAME, STATE, UID, WORKER_LAUNCHER, WORKER_UNIT
from vendure_admission import read_idle_queue, ready_socket, worker_binding


HELPER_FILES = (
    "deploy/recharge-core/check-provider-cutover.mjs",
    "deploy/recharge-core/release-gate.py",
    "deploy/recharge-core/run-recharge.py",
    "deploy/recharge-core/snapshot.py",
    "modules/recharge/vendure/codexdaichong-worker.mjs",
)


def trusted_file(path, *, executable=False):
    file = path.lstat()
    require(stat.S_ISREG(file.st_mode) and file.st_uid == 0 and not file.st_mode & 0o022 and
            path.resolve(strict=True) == path and (not executable or file.st_mode & stat.S_IXUSR),
            "interrupted_release_file_untrusted")
    return path


def stopped(unit):
    fields = set(run(["systemctl", "show", "-p", "ActiveState", "-p", "MainPID", unit]).decode().splitlines())
    require("MainPID=0" in fields and bool(fields & {"ActiveState=inactive", "ActiveState=failed"}),
            "interrupted_release_peripheral_not_stopped")


def staged_worker_matches(base, staged, source):
    # The existing launcher staging changes a verified revision or rewrites the
    # one read-only bind when the original worker used a different source.
    revisions = re.findall(r"(?m)^sha=([0-9a-f]{40})$", base)
    mounts = list(re.finditer(r'--mount[ \t]+"type=bind,src=([^,\n]+),dst=/app,readonly"', base))
    require(len(revisions) <= 1 and len(mounts) == 1, "interrupted_worker_launcher_ambiguous")
    mount = mounts[0]
    start, end = mount.span(1)
    if base[:start] + str(source) + base[end:] == staged:
        return True
    reference = mount[1]
    if not reference.startswith(str(ROOT) + "/") or "$" in reference:
        older = revisions[0] if revisions else "0" * 40
        reference = str(ROOT / "releases" / older / "source")
    return stage_worker_launcher(base, reference, source) == staged


class InterruptedCutover(CoreRelease):
    def __init__(self, plan, source, operations):
        interruption = plan["interruptedRelease"]
        previous = interruption["sha"]
        require(bool(re.fullmatch(r"[0-9a-f]{40}", previous)) and previous != plan["sha"],
                "invalid_interrupted_release_revision")
        candidate = ROOT / "releases" / plan["sha"]
        require((source is None and operations is None) or
                (source == candidate / "source" and operations == candidate / "operations"),
                "interrupted_release_candidate_path_mismatch")
        previous_release = ROOT / "releases" / previous
        super().__init__({"sha": previous, "before": interruption["before"]},
                         previous_release / "source", previous_release / "operations")
        self.candidate_source = source
        self.candidate_sha = plan["sha"]
        self.native = interruption["native"]
        self.gated_digest = plan["before"]["gatewaySha256"]
        self.gate_script_digest = interruption["gateSha256"]
        self.runtime_sources = interruption["runtimeSources"]
        require(isinstance(self.runtime_sources, dict) and set(self.runtime_sources) == set(HELPER_FILES),
                "interrupted_release_runtime_source_manifest_mismatch")
        self.worker_launcher = WORKER_LAUNCHER.with_name("run-vendure-worker-" + previous)

    def require_native_unchanged(self):
        native = native_publication_state()
        require(native == {"identity": self.native, "imageLabelsVerified": True},
                "interrupted_native_identity_changed")

    def require_native_launcher(self):
        state = run(["systemctl", "show", "-p", "ExecStart", "--value", NATIVE_UNIT]).decode()
        commands = re.findall(r"argv\[\]=([^;]+)", state)
        expected = ["/usr/bin/python3", str(self.scripts / "run-recharge.py"), "native", self.sha]
        require(len(commands) == 1 and shlex.split(commands[0]) == expected,
                "interrupted_native_service_binding_mismatch")

    def paused_marker_identity(self):
        marker = self.paused.lstat()
        require(stat.S_ISREG(marker.st_mode) and marker.st_uid == UID and marker.st_gid == GID and
                stat.S_IMODE(marker.st_mode) == 0o600 and marker.st_nlink == 1 and
                not os.path.lexists(self.marker), "interrupted_storefront_pause_marker_mismatch")
        return marker.st_dev, marker.st_ino, marker.st_size, marker.st_mtime_ns

    def require_paused(self):
        require(digest(trusted_file(GATEWAY)) == self.gated_digest and
                identity(inspect("caddy")) == self.gated_gateway and
                self.paused_marker_identity() == self.pause_evidence, "interrupted_release_intake_changed")

    def current_worker_binding(self):
        binding = worker_binding()
        commands = re.findall(rb"argv\[\]=([^;]+)", binding[0])
        require(len(commands) == 1 and shlex.split(commands[0].decode()) == ["/bin/bash", str(self.worker_launcher)],
                "interrupted_worker_service_binding_mismatch")
        return binding

    def prepare_worker(self):
        stopped(WORKER_UNIT)
        ready_socket()
        base = trusted_file(WORKER_LAUNCHER, executable=True)
        staged = trusted_file(self.worker_launcher, executable=True)
        launcher = staged.read_text()
        require(staged_worker_matches(base.read_text(), launcher, self.source),
                "interrupted_worker_launcher_mismatch")
        user_args = [shlex.split(line.strip().removesuffix("\\").rstrip()) for line in launcher.splitlines()
                     if re.match(r"^\s+--user ", line)]
        user_expression = "$(id -u id-business-independent):$(id -g id-business-independent)"
        require(user_args == [["--user", user_expression]], "interrupted_worker_user_mismatch")
        user = ":".join(run(["id", option, "id-business-independent"]).decode().strip() for option in ("-u", "-g"))
        image = trusted_file(FORMAL / "node-image-id").read_text().strip()
        require(re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", user) and
                re.fullmatch(r"sha256:[0-9a-f]{64}", image) and image == self.before["components"]["vendure"]["image"],
                "interrupted_worker_runtime_provenance_unverified")
        self.worker_expected = (image, user, str(self.source))
        self.worker_service_binding = self.current_worker_binding()
        require(self.worker_service_binding[1] == digest(base), "interrupted_worker_base_launcher_changed")
        self.worker_launcher_digest = digest(staged)
        run(["bash", "-n", str(staged)])

    def require_worker_binding_unchanged(self):
        require(self.current_worker_binding() == self.worker_service_binding and
                digest(trusted_file(self.worker_launcher, executable=True)) == self.worker_launcher_digest,
                "interrupted_worker_launcher_changed")

    def prepare(self):
        require_main(self.candidate_sha)
        for name in HELPER_FILES:
            expected = self.runtime_sources[name]
            require(digest(trusted_file(self.source / name)) == expected and
                    (self.candidate_source is None or digest(trusted_file(self.candidate_source / name)) == expected),
                    "interrupted_release_runtime_source_mismatch")
        self.require_native_unchanged()
        self.require_native_launcher()
        container = inspect("recharge-native")
        expected_mounts = {
            (str(FORMAL / "recharge-data" / name), "/candidate/.runtime/codexdaichong/" + name, True)
            for name in ("debug_screenshots", "product_files", "data")
        }
        expected_mounts.add((str(FORMAL / "recharge-data/data"), "/app/data", True))
        require(media_mounts(container) == expected_mounts and container["HostConfig"]["NetworkMode"] == "bridge",
                "interrupted_native_runtime_mounts_mismatch")
        require(ready_native(self.sha, self.native["image"], expected_mounts) == self.native,
                "interrupted_native_identity_changed")
        require_native_idle()
        provider = self.production_readback("--require-idle")
        require(not provider["providerActive"] and provider["providerInFlight"] == provider["providerUnresolved"] == 0,
                "interrupted_native_work_pending")

        gate = trusted_file(GATEWAY).read_text()
        script = trusted_file(self.scripts / "release-gate.py")
        require(digest(script) == self.gate_script_digest, "interrupted_release_gate_program_mismatch")
        transform = runpy.run_path(str(script))["gated_text"]
        ungated = transform(gate, self.sha, False)
        require(hashlib.sha256(ungated.encode()).hexdigest() == self.before["gatewaySha256"] and
                transform(ungated, self.sha, True) == gate, "interrupted_release_gate_not_original")
        self.gated_gateway = identity(inspect("caddy"))
        self.pause_evidence = self.paused_marker_identity()
        self.require_paused()

        stopped(ADAPTER_UNIT)
        try:
            inspect("recharge")
        except ContainerMetadataError as error:
            if error.reason != "not_found":
                raise
        else:
            require(False, "interrupted_adapter_container_exists")
        previous_adapter = self.before["adapterUnit"]["overrideSha256"]
        require((digest(trusted_file(ADAPTER_DROP)) == previous_adapter) if previous_adapter else
                not os.path.lexists(ADAPTER_DROP), "interrupted_adapter_override_changed")
        self.prepare_worker()
        self.queue_before = read_idle_queue(STATE / SQLITE_FILENAME)

        canary = json.loads(trusted_file(self.ops / "native-canary.receipt.json").read_text())
        require(canary["mainSha"] == self.sha and canary["productionWrites"] is False and
                NATIVE_CHECKS <= set(canary["checks"]), "interrupted_native_canary_receipt_mismatch")
        backup = ROOT / "backups" / ("recharge-core-" + self.sha)
        manifest = json.loads(trusted_file(backup / "manifest.json").read_text())
        backup_evidence = verify_snapshot_receipt(self.sha, {
            "backup": str(backup), "verified": manifest["verified"], "plainBytes": manifest["plainBytes"],
        })
        encrypted = hashlib.sha256()
        with trusted_file(backup / "mysql.sql.aes256gcm").open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                encrypted.update(chunk)
        require(encrypted.hexdigest() == backup_evidence["cipherSha256"], "interrupted_encrypted_backup_digest_mismatch")
        self.receipt = {
            "native": self.native, "nativeCanaryPassed": True, "nativeEngineUnchanged": True,
            "encryptedSnapshotVerified": True, "encryptedSnapshot": backup_evidence, "interruptedRevision": self.sha,
        }

    @contextmanager
    def cutover(self):
        require(self.candidate_source is not None, "interrupted_release_candidate_not_staged")
        require_main(self.candidate_sha)
        self.require_native_unchanged()
        self.require_native_launcher()
        self.require_paused()
        self.require_worker_binding_unchanged()
        require(read_idle_queue(STATE / SQLITE_FILENAME) == self.queue_before, "interrupted_storefront_queue_changed")
        yield self.native

    def finish(self):
        require(self.candidate_source is not None, "interrupted_release_candidate_not_staged")
        require_main(self.candidate_sha)
        self.require_native_unchanged()
        self.require_native_launcher()
        self.require_paused()
        self.require_worker_binding_unchanged()
        require(read_idle_queue(STATE / SQLITE_FILENAME) == self.queue_before, "interrupted_storefront_queue_changed")
        stopped(WORKER_UNIT)
        super().finish()

    def reopen(self):
        require_main(self.candidate_sha)
        self.require_native_unchanged()
        self.require_native_launcher()
        self.require_paused()
        self.require_worker_binding_unchanged()
        ready_socket()
        super().reopen()
        marker = self.marker.lstat()
        require((marker.st_dev, marker.st_ino, marker.st_size, marker.st_mtime_ns) == self.pause_evidence and
                not os.path.lexists(self.paused), "interrupted_storefront_acceptance_not_restored")
        self.require_native_unchanged()
