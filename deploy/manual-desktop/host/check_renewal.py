"""Exercise the installed renewal broker and worker using a disposable, empty profile."""

import asyncio
import os
import secrets
import shutil
import stat

from runtime import BRIDGE, GID, INPUTS, PROFILES, UID, WORKERS, checked_path, require


async def check_workspace():
    from aiohttp import ClientSession, ClientTimeout, UnixConnector, WSMsgType

    key = "manual-v1-" + secrets.token_hex(32)
    owner = "owner-v1-" + secrets.token_hex(32)
    endpoint = f"http://localhost/v1/workspaces/{key}/"
    profile, display, inputs = (parent / key for parent in (PROFILES, WORKERS, INPUTS))
    require(not os.path.lexists(display) and not os.path.lexists(inputs), "renewal_probe_directory_collision")
    # mkdir is exclusive. Only this probe's new profile can be seeded or removed.
    profile.mkdir(mode=0o700)
    identity = profile.lstat()
    stopped = True

    def client():
        return ClientSession(connector=UnixConnector(path=str(BRIDGE / "site.sock")),
                             headers={"X-Manual-Owner": owner}, timeout=ClientTimeout(total=60))

    async def action(name):
        async with client() as session, session.post(endpoint + name, allow_redirects=False) as response:
            require(response.status == 204, f"renewal_probe_{name}_http_{response.status}")

    async def connect():
        async with client() as session, session.ws_connect(endpoint + "stream", protocols=("binary",)) as screen:
            message = await screen.receive(timeout=5)
            require(message.type == WSMsgType.BINARY and message.data in
                    (b"RFB 003.007\n", b"RFB 003.008\n"), "renewal_probe_display_handshake_failed")

    try:
        marker = profile / "Local State"
        marker.write_text("{}", encoding="ascii")
        os.chown(marker, UID, GID)
        os.chown(profile, UID, GID)
        stopped = False
        await action("open")
        await connect()
        first = checked_path(display / "rfb.sock", stat.S_ISSOCK, 0o600, UID, GID).stat()
        await action("open")
        await connect()
        require(os.path.samestat(first, (display / "rfb.sock").lstat()), "renewal_probe_reconnect_changed_desktop")
        await action("stop")
        require(not os.path.lexists(display / "rfb.sock"), "renewal_probe_display_still_open")
        # Chromium created its own durable state upon the first clean shutdown.
        checked_path(profile / "Default" / "Preferences", stat.S_ISREG, uid=UID, gid=GID)
        await action("open")
        await connect()
    finally:
        if not stopped:
            await action("stop")
        require(not os.path.lexists(display / "rfb.sock"), "renewal_probe_display_still_open")
        require(os.path.samestat(identity, profile.lstat()) and shutil.rmtree.avoids_symlink_attacks,
                "renewal_probe_cleanup_identity_changed")
        for path in (profile, display, inputs):
            if path.exists():
                checked_path(path, stat.S_ISDIR, uid=UID, gid=GID)
                shutil.rmtree(path)


def run():
    asyncio.run(check_workspace())
