"""Stage, verify and switch the website and its explicitly selected adapter on the SSM host."""

import fcntl
from contextlib import nullcontext
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/opt/id-business-independent")
FORMAL = ROOT / "formal"
UNIT = "id-business-independent-app.service"
DROP = Path("/etc/systemd/system") / f"{UNIT}.d/90-current-release.conf"
GATEWAY = FORMAL / "gateway/Caddyfile"
LOCK = FORMAL / ".application-release.lock"
REPOSITORY = "https://github.com/wangchaozhuanyong/id-business-system.git"
BUCKET = "id-business-v2-backups-098208446664-ap-northeast-1"
SITE_HOST = "54-249-61-238.sslip.io"
WEBSITE = ("app", "drive-backup", "sheets-sync")
PROTECTED = ("recharge", "recharge-native", "vendure", "formal-mysql", "media", "caddy")
ADAPTER_UNIT = "id-business-independent-recharge.service"
ADAPTER_DROP = DROP.parent.parent / (ADAPTER_UNIT + ".d") / "99-id-managed-adapter-release.conf"
PINNED_UPSTREAM = "4e9bb201cf481d4bcc85da34970fc26c63ab818a"
REDEEM_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/gateway.mjs",
    "modules/recharge/codexdaichong/progress-presentation.mjs", "modules/recharge/codexdaichong/shell.js",
    "modules/recharge/codexdaichong/shell.css",
)
REDEEM_PRESENTATION_ASSETS = {"/workspace", "/shell.js", "/shell.css"}
WORKSPACE_PROGRESS_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs",
    "modules/recharge/codexdaichong/shell.js",
    "modules/recharge/codexdaichong/shell.css",
)
TABLE_ACTIONS_STYLESHEET = "modules/recharge/codexdaichong/shell.css"
CARD_IMPORT_ASSET_SOURCE = "modules/recharge/codexdaichong/assets.mjs"
CARD_IMPORT_PRESENTATION_FILES = (CARD_IMPORT_ASSET_SOURCE, "frontend/pagination.js", "frontend/tabs.css")
CARD_PLAN_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/card-plan-admin.mjs",
    "modules/recharge/codexdaichong/shell.css",
)
SECURITY_PRESENTATION_FILES = (
    "modules/recharge/codexdaichong/assets.mjs", "modules/recharge/codexdaichong/gateway.mjs",
)
PRESENTATION_SCOPES = {
    "redeemPresentation": (REDEEM_PRESENTATION_FILES, REDEEM_PRESENTATION_ASSETS),
    "workspaceProgressPresentation": (WORKSPACE_PROGRESS_PRESENTATION_FILES, REDEEM_PRESENTATION_ASSETS),
    "tableActionsPresentation": ((TABLE_ACTIONS_STYLESHEET,), {"/shell.css"}),
    "cardImportPresentation": (CARD_IMPORT_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "cardPlanPresentation": (CARD_PLAN_PRESENTATION_FILES, {"/admin", "/admin.js", "/shell.css"}),
    "securityPresentation": (SECURITY_PRESENTATION_FILES, {"/admin.js"}),
}
ADAPTER_MOUNTS = ("modules", "deploy/recharge-core")
LAUNCHERS = ("run-app", "app-entry.mjs", "check-app.mjs")
CANARY_LOG = "app-canary.log"
CANARY_RETRY_LOG = "app-canary.retry.log"
CANARY_MAILBOX_UNAVAILABLE = r"(?m)^RelayError: Vendure 邮箱服务暂时不可用，请重试\r?$"
CANARY_MAILBOX_RETRY_DELAY = 30
MONITORING = FORMAL / "backup-monitoring"
MONITORING_RECEIPTS = MONITORING / "receipts"
MONITORING_UNIT = "id-business-independent-backup-monitoring"
MONITORING_ENV = "ID_MONITOR_BACKUP_RECEIPTS_DIR=/run/id-backup-monitoring"
MONITORING_MOUNT = '  --mount "type=bind,src=$formal/backup-monitoring/receipts,dst=/run/id-backup-monitoring,readonly"'
ADMISSION_ENV = "ID_VENDURE_ADMISSION_DIRECTORY=/state/vendure-admission"
MONITORING_FILES = ("backup_monitoring.py", MONITORING_UNIT + ".service", MONITORING_UNIT + ".timer")
VERSIONED_ASSET = re.compile(r'\b(?:src|href)="(?:\./|/)?([a-zA-Z0-9.-]+\.(?:m?js|css))\?v=([a-zA-Z0-9.-]+)"')


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def run(args, timeout=25):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=timeout)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name):
    return json.loads(run(["docker", "inspect", "id-business-independent-" + name]))[0]


def identity(container):
    return {"id": container["Id"], "image": container["Image"],
            "running": container["State"]["Running"], "startedAt": container["State"]["StartedAt"],
            "revision": (container["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")}


def require_main(sha):
    remote = run(["git", "-c", "credential.helper=", "ls-remote", REPOSITORY, "refs/heads/main"])
    require(remote.decode().split() == [sha, "refs/heads/main"], "remote_main_changed")


def adapter_unit_state(components):
    adapter, native = components["recharge"], components["recharge-native"]
    image, revision = adapter["image"], adapter["revision"]
    require(adapter["running"] and native["running"] and image == native["image"] and
            re.fullmatch(r"sha256:[a-f0-9]{64}", image or "") and
            re.fullmatch(r"[a-f0-9]{40}", revision or "") and
            re.fullmatch(r"[a-f0-9]{40}", native["revision"] or ""), "adapter_runtime_identity_mismatch")
    labels = json.loads(run(["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image]))
    require(labels.get("org.id-business.upstream.revision") == PINNED_UPSTREAM and
            labels.get("org.opencontainers.image.revision") == native["revision"], "adapter_runtime_source_mismatch")
    binding = inspect("recharge-native")["NetworkSettings"]["Ports"].get("3000/tcp")
    require(binding == [{"HostIp": "127.0.0.1", "HostPort": "44579"}], "native_binding_mismatch")
    require(run(["systemctl", "is-active", ADAPTER_UNIT]).strip() == b"active", "adapter_unit_not_active")
    command = run(["systemctl", "show", "--property=ExecStart", "--value", ADAPTER_UNIT]).decode()
    require(re.search(r"/run-recharge\.py adapter " + revision + r"(?=[ ;}]|$)", command), "adapter_unit_launch_mismatch")
    override = None
    if ADAPTER_DROP.exists() or ADAPTER_DROP.is_symlink():
        info = ADAPTER_DROP.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and
                ADAPTER_DROP.read_text() == adapter_override(revision, native["revision"], image),
                "adapter_override_not_managed")
        override = digest(ADAPTER_DROP)
    return {"commandSha256": hashlib.sha256(command.encode()).hexdigest(), "overrideSha256": override}


def website_launcher(content, revision):
    commands = list(re.finditer(r"(?m)^[ \t]*ExecStart=[ \t]*(?P<path>[^ \t\r\n]+)", content))
    release = re.escape(str(ROOT / "releases" / revision))
    expected = release + r"/operations(?:-[a-zA-Z0-9_-]+)?/run-app"
    require(len(commands) == 1 and re.fullmatch(expected, commands[0]["path"]),
            "live_website_launcher_unrecognized")
    return commands[0]


def website_release_dropin(content, base, launcher):
    active = website_launcher(content, base)
    return content[:active.start("path")] + str(launcher) + content[active.end("path"):]


def snapshot(include_adapter=False):
    components = {name: identity(inspect(name)) for name in (*WEBSITE, *PROTECTED)}
    base = components["app"]["revision"]
    require(isinstance(base, str) and re.fullmatch(r"[a-f0-9]{40}", base), "invalid_live_revision")
    require(all(components[name]["running"] and components[name]["revision"] == base for name in WEBSITE),
            "website_and_sidecars_not_on_one_live_revision")
    require("# BEGIN ID CORE RELEASE " not in GATEWAY.read_text(), "core_release_gate_active")
    dropin = DROP.read_text()
    require(dropin.count(base) == 1, "live_service_revision_mismatch")
    live_operations = Path(website_launcher(dropin, base)["path"]).parent
    free = shutil.disk_usage(ROOT).free
    require(free > 12 * 1024**3, "insufficient_free_space")
    live = ROOT / "releases" / base
    state = {"components": components, "unitSha256": digest(DROP), "gatewaySha256": digest(GATEWAY),
             "assetsSha256": digest(live / "assets.json"), "freeBytes": free,
             "launchers": {name: digest(live_operations / name) for name in LAUNCHERS}}
    if include_adapter:
        state["adapterUnit"] = adapter_unit_state(components)
    return state


def check_baseline(current, expected):
    require(all(current[key] == expected[key] for key in
                ("components", "unitSha256", "gatewaySha256", "assetsSha256", "launchers")),
            "live_baseline_changed")
    require(current.get("adapterUnit") == expected.get("adapterUnit"), "live_adapter_unit_changed")


def write_new(path, value, mode):
    with path.open("x") as file:
        os.chmod(path, mode)
        file.write(value)
        file.flush()
        os.fsync(file.fileno())


def update_canary_asset_refs(content, previous_index, target_index):
    previous = dict(VERSIONED_ASSET.findall(previous_index))
    target = dict(VERSIONED_ASSET.findall(target_index))
    for name in previous.keys() & target.keys():
        if previous[name] == target[name]:
            continue
        for asset, query in ((name, "?"), (name.replace(".", r"\."), r"\?")):
            old = f"{asset}{query}v={previous[name]}"
            new = f"{asset}{query}v={target[name]}"
            pattern = rf"(?<![\w.-]){re.escape(old)}(?![\w.-])"
            content = re.sub(pattern, lambda _: new, content)
    return content


def wire_canary_authenticator(content):
    marker = "  // Enrollment for the synthetic canary administrator.\n"
    if marker in content:
        return content
    credentials = "  const login = await send('/api/local/auth/login', {method:'POST',body:credentials});\n"
    previous = credentials + """  assert.equal(login.status,200);
  const session = login.headers['set-cookie'][0].split(';')[0];
"""
    require(content.count(previous) == 1, "isolated_login_contract_changed")
    updated = credentials + """  assert.equal(login.status,200);
  const enrollmentSession = login.headers['set-cookie'][0].split(';')[0];
""" + marker + """  const beforeSecurity = await send('/api/local/auth/security', {session:enrollmentSession});
  assert.equal(beforeSecurity.status,200);
  assert.equal(JSON.parse(beforeSecurity.body).bound,false);
  const start = await send('/api/local/auth/security/start', {method:'POST',session:enrollmentSession,
    body:{password:credentials.password}});
  assert.equal(start.status,200);
  const {enrollment,setupKey} = JSON.parse(start.body);
  const {calculateTotp} = await import('/app/modules/tools/totp.mjs');
  const {code} = await calculateTotp(setupKey, Date.now());
  const bound = await send('/api/local/auth/security/confirm', {method:'POST',session:enrollmentSession,
    body:{enrollment,code}});
  assert.equal(bound.status,200);
  const session = bound.headers['set-cookie'][0].split(';')[0];
  const verified = await send('/api/local/auth/security', {session});
  assert.equal(verified.status,200);
  assert.equal(JSON.parse(verified.body).recentlyVerified,true);
"""
    return content.replace(previous, updated)


def mount_backup_monitoring(content):
    original = '  state=(--mount "type=bind,src=$formal/data,dst=/state")'
    mounted = original[:-1] + "\n" + MONITORING_MOUNT + f'\n  -e "{MONITORING_ENV}")'
    if content.count(mounted) == 1 and content.count(MONITORING_ENV) == 1:
        return content
    require(content.count(original) == 1 and "ID_MONITOR_BACKUP_RECEIPTS_DIR" not in content,
            "unexpected_backup_monitoring_launcher")
    return content.replace(original, mounted)


def mount_storefront_admission(content):
    monitored = f'  -e "{MONITORING_ENV}")'
    configured = monitored + f'\n  state+=(-e "{ADMISSION_ENV}")'
    if content.count(configured) == 1 and content.count(ADMISSION_ENV) == 1:
        return content
    require(content.count(monitored) == 1 and "ID_VENDURE_ADMISSION_DIRECTORY" not in content,
            "unexpected_storefront_admission_launcher")
    return content.replace(monitored, configured)


def wire_storefront_analytics(content):
    """Read the optional Cloudflare configuration from the existing sealed tools credential."""
    replacements = (
        ("const { analytics, visits, microsoft } = JSON.parse(toolConfig);",
         "const { analytics, visits, microsoft, cloudflare } = JSON.parse(toolConfig);"),
        ("  ['microsoft', JSON.stringify(microsoft)]\n",
         "  ['microsoft', JSON.stringify(microsoft)],\n"
         "  ...(cloudflare === undefined ? [] : [['cloudflare', JSON.stringify(cloudflare)]])\n"),
        ("const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig] = await Promise.all([",
         "const [websiteAnalyticsConfig, websiteVisitsSecret, microsoftMailboxConfig, websiteCloudflareConfig] = await Promise.all(["),
        ("  readToolConfig('/credentials/microsoft', 'microsoft-mailbox')\n",
         "  readToolConfig('/credentials/microsoft', 'microsoft-mailbox'),\n"
         "  readToolConfig(cloudflare === undefined ? undefined : '/credentials/cloudflare', 'website-cloudflare')\n"),
        ("  websiteAnalyticsConfig,\n", "  websiteAnalyticsConfig,\n  websiteCloudflareConfig,\n"),
    )
    if "websiteCloudflareConfig" in content or "['cloudflare'," in content:
        require(all(content.count(new) == 1 for _, new in replacements),
                "unexpected_storefront_analytics_launcher")
        return content
    require(all(content.count(old) == 1 for old, _ in replacements),
            "unexpected_storefront_analytics_launcher")
    for old, new in replacements:
        content = content.replace(old, new)
    return content


def normalize_tools_credential_stream(content):
    # The app-entry protocol has one line per credential. A valid JSON file may
    # contain formatting or a final newline; preserve its values before framing.
    original = '  cat "$CREDENTIALS_DIRECTORY/independent-online-tools"'
    normalized = (
        "  python3 -c 'import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), separators=(\",\", \":\")))'"
        ' < "$CREDENTIALS_DIRECTORY/independent-online-tools"'
    )
    if normalized in content:
        require(content.count(normalized) == 1 and original not in content,
                "unexpected_tools_credential_stream")
        return content
    require(content.count(original) == 1, "unexpected_tools_credential_stream")
    return content.replace(original, normalized)


def wire_event_launcher(content):
    credential = '  cat "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"'
    framed = (
        "  python3 -c 'import json,sys; sys.stdout.write(json.dumps(json.load(sys.stdin), separators=(\",\", \":\")))'"
        ' < "$CREDENTIALS_DIRECTORY/independent-vendure-integrations"\n'
        "  printf '\\n'\n"
        '  if [ "$mode" = live ]; then\n'
        '    cat "$CREDENTIALS_DIRECTORY/independent-recharge-events"\n'
        "  else printf disabled; fi"
    )
    state = f'  state+=(-e "{ADMISSION_ENV}")'
    mounted = state + '\n  state+=(\n' + \
        '    --mount "type=bind,src=$root/releases/$sha/runtime/external-events,dst=/external-events-runtime,readonly"\n' + \
        '    --mount "type=bind,src=$root/releases/$sha/runtime/mysql-ca.pem,dst=/run/recharge-mysql-ca.pem,readonly")'
    if 'independent-recharge-events' in content:
        require(content.count(framed) == 1 and content.count(mounted) == 1, 'unexpected_event_launcher')
        return content
    require(content.count(credential) == 1 and content.count(state) == 1, 'unexpected_event_launcher')
    return content.replace(credential, framed).replace(state, mounted)


def wire_event_entry(content):
    old = 'const [toolConfig, vendureConfig] = '
    new = 'const [toolConfig, vendureConfig, eventPassword] = '
    anchor = '  relayConfig,\n'
    configured = anchor + "  rechargeEventsConfig: mode === 'live' ? {\n" + \
        "    host: '127.0.0.1', port: 44576, user: 'id_recharge_events', password: eventPassword,\n" + \
        "    database: 'id_redesign_codexdaichong_prod', serverId: 3511012,\n" + \
        "    caFile: '/run/recharge-mysql-ca.pem', pythonPath: '/external-events-runtime',\n" + \
        "    checkpointPath: '/state/recharge-events.checkpoint.json'\n" + \
        "  } : undefined,\n"
    guard = "if (mode === 'live' && !/^[a-f0-9]{64}$/.test(eventPassword || '')) throw new Error('event_credential_required');\n"
    start = 'const service = await startPreview('
    if 'eventPassword' in content:
        require(content.count(new) == 1 and content.count(configured) == 1 and content.count(guard) == 1,
                'unexpected_event_entry')
        return content
    require(content.count(old) == 1 and content.count(anchor) == 1 and content.count(start) == 1,
            'unexpected_event_entry')
    return content.replace(old, new).replace(anchor, configured).replace(start, guard + start)


def wire_event_credential(content):
    line = 'LoadCredentialEncrypted=independent-recharge-events:' + str(FORMAL / 'private/independent-recharge-events.cred')
    if 'independent-recharge-events' in content:
        require(content.splitlines().count(line) == 1, 'unexpected_event_credential_unit')
        return content
    require(content.count('[Service]') == 1 and (FORMAL / 'private/independent-recharge-events.cred').is_file(),
            'event_prerequisites_missing')
    return content.rstrip() + '\n' + line + '\n'


def stage_event_runtime(plan, release):
    require((FORMAL / 'private/independent-recharge-events.cred').is_file(), 'event_prerequisites_missing')
    require('path /shop-api /storefront-realtime/mail-events' in GATEWAY.read_text(), 'mail_event_gateway_missing')
    runtime = release / 'runtime'
    target = runtime / 'external-events'
    target.mkdir(parents=True, mode=0o755)
    run(['tar', '-xzf', str(release / 'artifacts' / f"independent-event-runtime-{plan['sha']}.tar.gz"), '-C', str(target)])
    manifest = json.loads((target / 'manifest.json').read_text())
    require(manifest['sha'] == plan['sha'] and bool(manifest['files']) and
            all(digest(target / name) == value for name, value in manifest['files'].items()), 'event_runtime_hash_mismatch')
    certificate = run(['docker', 'exec', 'id-business-independent-formal-mysql', 'cat', '/var/lib/mysql/ca.pem']).decode()
    require(certificate.startswith('-----BEGIN CERTIFICATE-----') and 'PRIVATE KEY' not in certificate,
            'mysql_ca_certificate_invalid')
    write_new(runtime / 'mysql-ca.pem', certificate, 0o644)


def presentation_scope(plan):
    scopes = [name for name in PRESENTATION_SCOPES if name in plan]
    require(len(scopes) <= 1, "recharge_presentation_approval_mismatch")
    return scopes[0] if scopes else None


def require_asset_digest(plan, candidate_sha):
    before = plan["before"]["assetsSha256"]
    scope = presentation_scope(plan)
    if plan.get("rechargeCore"):
        require(scope is None and plan.get("adapter") and
                plan["rechargeCore"]["assetsSha256"] == candidate_sha and
                re.fullmatch(r"[a-f0-9]{64}", candidate_sha), "native_recharge_asset_digest_mismatch")
        return
    if scope is None:
        require(candidate_sha == before, "recharge_assets_changed")
        return
    presentation = plan[scope]
    approved_files, _ = PRESENTATION_SCOPES[scope]
    require(isinstance(presentation, dict) and not plan.get("adapter") and
            set(approved_files) <= set(plan["files"]) and
            presentation.get("beforeAssetsSha256") == before and presentation.get("assetsSha256") == candidate_sha and
            candidate_sha != before and re.fullmatch(r"[a-f0-9]{64}", candidate_sha),
            "recharge_presentation_approval_mismatch")
    return scope


def verify_presentation_bundle(previous, candidate, approved_assets):
    old, new = (json.loads(path.read_bytes()) for path in (previous, candidate))
    require(old["revision"] == new["revision"] == PINNED_UPSTREAM and
            old["assets"].keys() == new["assets"].keys(), "recharge_presentation_bundle_scope_mismatch")
    changes = {name for name, asset in old["assets"].items() if new["assets"][name] != asset}
    require(changes == approved_assets, "recharge_presentation_bundle_scope_mismatch")


def stage(plan, release):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    require(sha != base, "release_revision_already_running")
    live_operations = Path(website_launcher(DROP.read_text(), base)["path"]).parent
    source_name = f"independent-source-{sha}.tar.gz"
    assets_name = f"independent-assets-{sha}.json"
    expected_names = {source_name, assets_name}
    if plan.get('externalEvents'):
        expected_names.add(f"independent-event-runtime-{sha}.tar.gz")
    require(set(plan["artifacts"]) == expected_names, "invalid_artifact_names")
    scope = require_asset_digest(plan, plan["artifacts"][assets_name]["sha256"])
    require(not release.exists(), "release_directory_already_exists_inspect_before_retry")
    release.mkdir(mode=0o755)
    artifacts = release / "artifacts"
    artifacts.mkdir(mode=0o700)
    for name, expected in plan["artifacts"].items():
        target = artifacts / name
        run(["aws", "s3", "cp", f"s3://{BUCKET}/release-artifacts/formal/{sha}/{name}", str(target),
             "--region", "ap-northeast-1", "--only-show-errors"], timeout=75)
        require(target.stat().st_size == expected["bytes"] and digest(target) == expected["sha256"],
                "downloaded_artifact_mismatch")
    source = release / "source"
    source.mkdir(mode=0o755)
    run(["tar", "-xzf", str(artifacts / source_name), "-C", str(source)])
    require(all(digest(source / name) == expected for name, expected in plan["files"].items()),
            "prepared_source_mismatch")
    if plan.get('externalEvents'):
        stage_event_runtime(plan, release)
    live = ROOT / "releases" / base
    if scope:
        verify_presentation_bundle(live / "assets.json", artifacts / assets_name, PRESENTATION_SCOPES[scope][1])
    (source / ".runtime").mkdir(mode=0o755)
    shutil.copyfile(artifacts / assets_name, release / "assets.json")
    os.chmod(release / "assets.json", 0o644)
    ops = release / "operations"
    ops.mkdir(mode=0o755)
    for name in LAUNCHERS:
        previous = live_operations / name
        require(digest(previous) == before["launchers"][name], "live_launcher_changed")
        content = previous.read_text()
        if live_operations.name != "operations":
            content = re.sub(rf"/{re.escape(live_operations.name)}(?![a-zA-Z0-9_.-])", "/operations", content)
        if name == "run-app":
            require(content.count("sha=" + base) == 1, "live_launcher_revision_mismatch")
            content = normalize_tools_credential_stream(mount_storefront_admission(
                mount_backup_monitoring(content.replace("sha=" + base, "sha=" + sha))))
        elif name == "app-entry.mjs":
            content = wire_storefront_analytics(content)
        elif name == "check-app.mjs":
            content = update_canary_asset_refs(content, (live / "source/frontend/index.html").read_text(),
                                               (source / "frontend/index.html").read_text())
            if scope == "securityPresentation":
                content = wire_canary_authenticator(content)
        if plan.get('externalEvents'):
            if name == 'run-app':
                content = wire_event_launcher(content)
            elif name == 'app-entry.mjs':
                content = wire_event_entry(content)
        write_new(ops / name, content, 0o755 if name == "run-app" else 0o644)
    return source, ops


def write_website_version(source, sha):
    path = source / "server/.website-version.json"
    write_new(path, json.dumps({"version": sha, "updatedAt": time.time_ns() // 1_000_000}) + "\n", 0o444)


def read_canary_log(path):
    with path.open("rb") as file:
        size = path.stat().st_size
        file.seek(max(size - 64 * 1024, 0))
        return size, file.read().decode(errors="replace")


def canary(sha, ops):
    deadline = time.monotonic() + 240
    names = ("independent-recharge-bridge", "independent-online-tools", "independent-vendure-integrations")
    credentials = [f"--property=LoadCredentialEncrypted={name}:{FORMAL / 'private' / (name + '.cred')}"
                   for name in names]
    for log_name, unit_suffix in ((CANARY_LOG, ""), (CANARY_RETRY_LOG, "-retry")):
        remaining = int(deadline - time.monotonic())
        require(remaining >= 16, "isolated_app_canary_retry_timeout")
        unit = "id-website-release-canary-" + sha[:12] + unit_suffix
        args = ["systemd-run", "--collect", "--wait", "--pipe", "--unit=" + unit,
                f"--property=RuntimeMaxSec={min(225, remaining - 15)}", *credentials]
        log_path = ops / log_name
        with log_path.open("xb") as log:
            os.chmod(log.name, 0o600)
            result = subprocess.run([*args, str(ops / "run-app"), "canary"], stdout=log,
                                    stderr=subprocess.STDOUT, timeout=remaining)
        if result.returncode == 0:
            return bool(unit_suffix)
        if unit_suffix or not re.search(CANARY_MAILBOX_UNAVAILABLE, read_canary_log(log_path)[1]):
            raise ReleaseError("isolated_app_canary_failed")
        # Leave time for the mailbox API to recover from a runtime restart.
        require(deadline - time.monotonic() >= CANARY_MAILBOX_RETRY_DELAY + 16,
                "isolated_app_canary_retry_timeout")
        time.sleep(CANARY_MAILBOX_RETRY_DELAY)


def canary_diagnostics(text):
    indicators = {
        "assertion": r"ERR_ASSERTION|AssertionError",
        "connection_refused": r"ECONNREFUSED|Connection refused",
        "address_in_use": r"EADDRINUSE|address already in use",
        "module_missing": r"ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND",
        "missing_file": r"ENOENT|No such file or directory",
        "permission_denied": r"EACCES|Permission denied",
        "vendure_mailbox_unavailable": CANARY_MAILBOX_UNAVAILABLE,
        "systemd_start_failed": r"Failed to start transient|Failed to start.*service",
        "timeout": r"TimeoutError|timed out",
    }
    frames = re.findall(r"\b(check-app\.mjs|app-entry\.mjs|preview\.mjs):(\d+):(\d+)", text)
    assets = re.findall(r"\b(?:commerce-prototype\.js|prototype\.css|prototype\.js|"
                        r"subscription-management\.js|order-opening\.mjs)(?:\?v=[a-zA-Z0-9-]+)?", text)
    return {"indicators": [name for name, pattern in indicators.items() if re.search(pattern, text, re.I)],
            "frames": [list(frame) for frame in dict.fromkeys(frames)][:12],
            "assets": sorted(set(assets))[:20]}


def inspect_canary(sha):
    require(re.fullmatch(r"[a-f0-9]{40}", sha), "invalid_canary_revision")
    ops = ROOT / "releases" / sha / "operations"
    retried = (ops / CANARY_RETRY_LOG).is_file()
    size, log = read_canary_log(ops / (CANARY_RETRY_LOG if retried else CANARY_LOG))
    return {"attemptSha": sha, "liveWebsiteSha": identity(inspect("app"))["revision"],
            "bytes": size, "retried": retried, **canary_diagnostics(log)}


def mount_matches(container, source, destination=None):
    return any(mount["Source"] == str(source) and not mount["RW"]
               and (destination is None or mount["Destination"] == destination)
               for mount in container["Mounts"])


def adapter_canary(plan, source, ops):
    image = plan["before"]["components"]["recharge"]["image"]
    with (ops / "adapter-canary.log").open("xb") as log:
        os.chmod(log.name, 0o600)
        outcome = subprocess.run(["python3", str(source / "deploy/recharge-core/canary.py"), plan["sha"], image],
                                 stdout=log, stderr=subprocess.STDOUT, timeout=260)
    if outcome.returncode:
        try:
            reason = json.loads((ops / "adapter-canary.log").read_text().splitlines()[-1]).get("reason", "")
        except (IndexError, ValueError):
            reason = ""
        raise ReleaseError("adapter_canary_failed" + (": " + reason if re.fullmatch("[a-z0-9_]+", reason) else ""))
    receipt = json.loads((ops / "native-canary.receipt.json").read_text())
    checks = {"source_203_native", "source_203_adapter", "synthetic_card_stop_and_retry_preserved_history",
              "no_payment_or_activation_requests", "owned_temporary_containers_removed"}
    require(receipt.get("mainSha") == plan["sha"] and receipt.get("productionWrites") is False and
            checks.issubset(receipt["checks"]), "adapter_canary_receipt_mismatch")


def adapter_override(sha, native, image):
    launcher = ROOT / "releases" / sha / "source/deploy/recharge-core/run-recharge.py"
    return f"[Service]\nExecStart=\nExecStart=/usr/bin/python3 {launcher} adapter {sha} {native} {image}\n"


def require_native_idle():
    request = urllib.request.Request("http://127.0.0.1:44579/api/public/runtime")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        with opener.open(request, timeout=5) as response:
            status = json.loads(response.read(8192))
        active = status.get("runtime", {}).get("active_foreground_jobs")
        require(status.get("success") is True and type(active) is int and active >= 0, "native_runtime_unavailable")
        if active == 0:
            return
        time.sleep(3)
    raise ReleaseError("native_recharge_work_in_progress")


def switch_adapter(plan, source, ops, native_runtime=None):
    before, sha = plan["before"], plan["sha"]
    native = native_runtime or before["components"]["recharge-native"]
    image = native["image"]
    require(identity(inspect("recharge-native")) == native, "live_native_baseline_changed")
    if not native_runtime:
        require(adapter_unit_state(before["components"]) == before["adapterUnit"], "live_adapter_baseline_changed")
        require_native_idle()
    require_main(sha)
    ADAPTER_DROP.parent.mkdir(mode=0o755, exist_ok=True)
    directory = ADAPTER_DROP.parent.lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and directory.st_mode & 0o022 == 0,
            "adapter_override_directory_mismatch")
    if ADAPTER_DROP.exists():
        write_new(ops / "recharge-adapter.before.conf", ADAPTER_DROP.read_text(), 0o600)
    pending = ADAPTER_DROP.with_name(f".{ADAPTER_DROP.name}.{sha[:12]}")
    write_new(pending, adapter_override(sha, native["revision"], image), 0o644)
    os.replace(pending, ADAPTER_DROP)
    run(["systemctl", "daemon-reload"])
    command = run(["systemctl", "show", "--property=ExecStart", "--value", ADAPTER_UNIT]).decode()
    require(str(source / "deploy/recharge-core/run-recharge.py") + f" adapter {sha} {native['revision']} {image}" in command,
            "adapter_effective_command_mismatch")
    run(["systemctl", "restart", ADAPTER_UNIT], timeout=55)
    deadline = time.monotonic() + 55
    while time.monotonic() < deadline:
        try:
            container = inspect("recharge")
            state = identity(container)
            if (state["running"] and state["revision"] == sha and state["image"] == image and
                    all(mount_matches(container, source / name, "/candidate/" + name) for name in ADAPTER_MOUNTS)):
                flag = "--check-card-plans" if native_runtime else "--check-card-stop"
                ready = json.loads(run(["docker", "exec", state["id"], "node",
                                        "/candidate/deploy/recharge-core/health.mjs", flag], timeout=14))
                expected = ({"ready": True, "cardPlansReady": True, "retiredProviderRoute": 404}
                            if native_runtime else {"ready": True, "cardStopRouteReady": True})
                if ready == expected:
                    break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
            pass
        time.sleep(1)
    else:
        raise ReleaseError("adapter_readback_failed")
    for name in plan["adapter"]["runtimeFiles"]:
        reported = run(["docker", "exec", state["id"], "sha256sum", "/candidate/" + name]).decode().split()[0]
        require(reported == plan["files"][name], "adapter_source_mismatch")
    require(identity(inspect("recharge-native")) == native, "native_engine_changed")
    return state


def install_backup_monitoring(source, sha):
    user = inspect("app")["Config"]["User"]
    data = (FORMAL / "data").lstat()
    require(data.st_uid > 0 and user == f"{data.st_uid}:{data.st_gid}", "backup_monitor_site_identity_mismatch")
    scripts = FORMAL / "ops/backup-monitoring"
    for directory, group, mode in ((MONITORING, 0, 0o755), (MONITORING_RECEIPTS, data.st_gid, 0o750),
                                   (scripts, 0, 0o755)):
        if not directory.exists():
            directory.mkdir(mode=mode)
            os.chown(directory, 0, group)
            directory.chmod(mode)
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and directory.resolve() == directory and info.st_uid == 0 and
                info.st_gid == group and stat.S_IMODE(info.st_mode) == mode, "backup_monitor_directory_mismatch")
    for name in MONITORING_FILES:
        target = (scripts if name.endswith(".py") else DROP.parent.parent) / name
        content = (source / "deploy/website" / name).read_text()
        if target.exists() or target.is_symlink():
            info = target.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o644,
                    "backup_monitor_managed_file_mismatch")
            if target.read_text() == content:
                continue
        pending = target.with_name(f".{name}.{sha[:12]}")
        write_new(pending, content, 0o644)
        os.replace(pending, target)
    timer, service = MONITORING_UNIT + ".timer", MONITORING_UNIT + ".service"
    run(["systemd-analyze", "verify", str(DROP.parent.parent / service), str(DROP.parent.parent / timer)])
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", timer])
    run(["systemctl", "start", service])
    require(run(["systemctl", "is-active", timer]).strip() == b"active" and
            (MONITORING_RECEIPTS / "backup-status.json").is_file(), "backup_monitor_timer_unavailable")


def read_backup_monitoring(container):
    require(mount_matches(container, MONITORING_RECEIPTS, "/run/id-backup-monitoring") and
            MONITORING_ENV in container["Config"]["Env"], "backup_monitor_mount_mismatch")
    check = """
import { createMonitoringSources } from '/app/server/monitoring-sources.mjs';
import { readBackupMonitorReceipt } from '/app/server/monitoring-worker-receipts.mjs';
const directory = process.env.ID_MONITOR_BACKUP_RECEIPTS_DIR;
if (!await readBackupMonitorReceipt(directory)) throw Error('invalid backup monitor receipt');
const states = {};
const monitor = { probeAt: () => 0, observe(samples) {
  for (const { code, status } of samples)
    if (code === 'backup' || code === 'recharge_backup') states[code] = status;
} };
const source = createMonitoringSources({ monitor, databasePath: '/state/local-business.sqlite',
  backupReceiptDirectory: directory });
await source.tick();
source.close();
console.log(JSON.stringify(states));
"""
    status = json.loads(run(["docker", "exec", "id-business-independent-app", "node", "--input-type=module", "-e", check]))
    require(set(status) == {"backup", "recharge_backup"} and all(value != "disabled" for value in status.values()),
            "backup_monitor_check_missing")
    return status


def http(path):
    request = urllib.request.Request("http://127.0.0.1:44572" + path, headers={"Host": SITE_HOST})
    return urllib.request.urlopen(request, timeout=5)


def read_event_runtime():
    name = 'independent-mysql-root'
    password = run(['systemd-creds', 'decrypt', '--name=' + name,
                    str(FORMAL / 'private' / (name + '.cred')), '-']).decode().strip()
    require(re.fullmatch('[a-f0-9]{64}', password), 'event_health_credential_invalid')
    query = ("SELECT @@server_uuid, @@binlog_row_metadata, "
             "(SELECT COUNT(*) FROM performance_schema.threads WHERE PROCESSLIST_USER='id_recharge_events' "
             "AND PROCESSLIST_COMMAND LIKE 'Binlog Dump%');\n")
    checkpoint = FORMAL / 'data/recharge-events.checkpoint.json'
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        result = subprocess.run(['docker', 'exec', '-i', 'id-business-independent-formal-mysql', 'bash', '-ec',
            'IFS= read -r MYSQL_PWD; export MYSQL_PWD; exec mysql --host=127.0.0.1 --user=root --batch --skip-column-names'],
            input=(password + '\n' + query).encode(), capture_output=True, timeout=15)
        if result.returncode == 0:
            fields = result.stdout.decode().strip().split('\t')
            if len(fields) == 3 and fields[1:] == ['FULL', '1'] and checkpoint.is_file():
                state = json.loads(checkpoint.read_text())
                if state.get('snapshotDone') is True and state.get('source') == fields[0]:
                    require(checkpoint.stat().st_mode & 0o777 == 0o600, 'event_checkpoint_permissions_invalid')
                    return {'readerConnected': True, 'snapshotAcknowledged': True, 'metadata': 'FULL',
                            'checkpointPrivate': True, 'businessTestWrites': 0}
        time.sleep(3)
    raise ReleaseError('event_runtime_not_ready')


def read_website(plan, release, source, adapter=None, core=None):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        try:
            containers = {name: inspect(name) for name in WEBSITE}
            states = {name: identity(value) for name, value in containers.items()}
            running_expected = all(state["running"] and state["revision"] == plan["sha"] and
                                   state["image"] == plan["before"]["components"][name]["image"]
                                   for name, state in states.items())
            if running_expected and all(mount_matches(containers[name], source, "/app") for name in WEBSITE[1:]):
                with http("/") as response:
                    require(response.status == 200, "website_home_unavailable")
                break
        except (subprocess.CalledProcessError, urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1)
    else:
        raise ReleaseError("website_or_sidecar_readback_failed")
    require(mount_matches(containers["app"], release / "assets.json"), "live_assets_mount_mismatch")
    require_asset_digest(plan, digest(release / "assets.json"))
    require(all(any(m["Destination"] == "/state" and not m["RW"] for m in containers[name]["Mounts"])
                for name in WEBSITE[1:]), "sidecar_state_mount_not_readonly")
    hash_files = """
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const files = JSON.parse(process.argv[1]);
const hashes = files.map(name => [name, createHash('sha256').update(readFileSync('/app/' + name)).digest('hex')]);
console.log(JSON.stringify(Object.fromEntries(hashes)));
"""
    running_hashes = json.loads(run(["docker", "exec", "id-business-independent-app", "node", "--input-type=module",
                                    "-e", hash_files, json.dumps(list(plan["files"]))]))
    require(running_hashes == plan["files"], "running_source_mismatch")
    module_paths = {
        "frontend/staff-workspaces.mjs": "/assets/website/pages/staff-workspaces.mjs",
        "frontend/finance-reconciliation.mjs": "/assets/website/pages/finance-reconciliation.mjs",
        "modules/website/pages.mjs": "/assets/website/pages.mjs",
        **{name: "/" + name for name in (
            "modules/orders/order-opening.mjs", "modules/orders/list-order.mjs",
            "modules/orders/renewal-reminders.mjs", "modules/finance/apple-funding.mjs",
            "modules/data/document-delta.mjs", "modules/orders/order-list.mjs", "modules/inventory/list.mjs",
            "modules/finance/accounting.mjs", "modules/data/record-edit.mjs"
        )},
    }
    for name, expected in plan["files"].items():
        route = module_paths.get(name)
        if not route and name.startswith("frontend/") and name != "frontend/index.html":
            route = "/" + Path(name).name
        if route:
            with http(route) as response:
                require(hashlib.sha256(response.read()).hexdigest() == expected, "live_website_asset_mismatch")
    protected_reads = ("/api/local/settings", "/api/local/inventory", "/api/local/commerce", "/api/local/order-sync",
                       "/api/local/system-monitoring", "/api/local/recharge-activity")
    if (source / "server/site-management.mjs").is_file():
        protected_reads += ("/api/local/site-management?view=information", "/api/local/site-management?view=backups",
                            "/api/local/renewals?view=finance", "/api/local/staff/finance/cards",
                            "/api/local/auth/security/network")
        version = json.loads(run(["docker", "exec", "id-business-independent-app", "cat", "/app/server/.website-version.json"]))
        require(version == json.loads((source / "server/.website-version.json").read_text()) and
                version.get("version") == plan["sha"], "website_version_receipt_mismatch")
    if (source / "modules/website/pages.mjs").is_file():
        protected_reads += ("/api/local/staff/finance/reconciliation", "/api/local/renewal-sidebar")
    if adapter:
        protected_reads += ("/api/local/subscription-card-status",)
    for path in protected_reads:
        try:
            with http(path):
                raise ReleaseError("anonymous_protected_read_allowed")
        except urllib.error.HTTPError as error:
            require(error.code in (401, 403), "protected_read_status_unexpected")
    expected = plan["before"]["components"] | ({"recharge": adapter} if adapter else {})
    gateway_digest = plan["before"]["gatewaySha256"]
    if core:
        expected = expected | {"recharge-native": core.receipt["native"], "caddy": core.gated_gateway}
        gateway_digest = core.gated_digest
    require(all(identity(inspect(name)) == expected[name] for name in PROTECTED),
            "protected_component_changed")
    require(digest(GATEWAY) == gateway_digest, "gateway_changed")
    return states


def release_website(plan):
    sha = plan["sha"]
    before = plan["before"]
    base = before["components"]["app"]["revision"]
    include_adapter = bool(plan.get("adapter"))
    check_baseline(snapshot(include_adapter), before)
    release = ROOT / "releases" / sha
    source, ops = stage(plan, release)
    core = None
    if plan.get("rechargeCore"):
        sys.path.insert(0, str(source / "deploy/website"))
        try:
            from recharge_core import CoreRelease
        finally:
            sys.path.pop(0)
        core = CoreRelease(plan, source, ops)
    canary_retried = canary(sha, ops)
    if include_adapter and not core:
        adapter_canary(plan, source, ops)
    if core:
        core.prepare()
    check_baseline(snapshot(include_adapter), before)
    old = DROP.read_text()
    launcher = ops / "run-app"
    require(launcher.is_file() and os.access(launcher, os.X_OK), "staged_website_launcher_not_executable")
    new = website_release_dropin(old, base, launcher)
    if plan.get('externalEvents'):
        new = wire_event_credential(new)
    require_main(sha)
    if (source / "server/site-management.mjs").is_file():
        write_website_version(source, sha)
    install_backup_monitoring(source, sha)
    with core.cutover() if core else nullcontext() as native:
        adapter = switch_adapter(plan, source, ops, native) if native else (
            switch_adapter(plan, source, ops) if include_adapter else None)
        require_main(sha)
        require(digest(DROP) == before["unitSha256"], "live_service_override_changed")
        write_new(ops / "id-business-independent-app.service.before.conf", old, 0o600)
        pending = DROP.with_name(f".{DROP.name}.{sha[:12]}")
        write_new(pending, new, DROP.stat().st_mode & 0o777)
        os.replace(pending, DROP)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "restart", UNIT], timeout=55)
        live = read_website(plan, release, source, adapter, core) if core else read_website(plan, release, source, adapter)
        events = read_event_runtime() if plan.get('externalEvents') else None
        monitoring = read_backup_monitoring(inspect("app"))
        if core:
            core.finish()
    result = {"mainSha": sha, "previousWebsiteSha": base, "website": live["app"],
              "sidecars": {name: live[name] for name in WEBSITE[1:]},
              "sourceFilesVerified": len(plan["files"]), "artifacts": plan["artifacts"],
              "qualityRun": plan["qualityRun"], "preflightCommand": plan["preflightCommand"],
              "appCanaryPassed": True, "appCanaryRetried": canary_retried,
              "protectedComponentsUnchanged": not include_adapter,
              "liveAssetsSha256": digest(release / "assets.json"),
              "backupMonitoring": monitoring,
              "unauthenticatedProtectedReadsRejected": True, "productionBusinessTestWrites": False}
    if events:
        result['externalEvents'] = events
    scope = presentation_scope(plan)
    if scope:
        result[scope + "Verified"] = True
    if core:
        result.update(adapter=adapter, rechargeCore=core.receipt)
    elif adapter:
        result.update(adapter=adapter, adapterCanaryPassed=True, nativeEngineUnchanged=True,
                      otherProtectedComponentsUnchanged=True)
    write_new(ops / "release.receipt.json", json.dumps(result, indent=2) + "\n", 0o600)
    return result


def main(plan):
    try:
        require(re.fullmatch(r"[a-f0-9]{40}", plan["sha"]), "invalid_release_revision")
        with LOCK.open("r") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require_main(plan["sha"])
            if plan["operation"] == "preflight":
                result = snapshot(plan.get("adapter") is True)
            elif plan["operation"] == "inspect":
                result = inspect_canary(plan["attemptSha"])
            else:
                require(plan["operation"] == "release", "invalid_release_operation")
                result = release_website(plan)
            print(json.dumps(result, sort_keys=True), flush=True)
    except ReleaseError as error:
        sys.exit(str(error))
    except BlockingIOError:
        sys.exit("application_release_lock_busy")
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        sys.exit("website_release_error: " + type(error).__name__.lower())
