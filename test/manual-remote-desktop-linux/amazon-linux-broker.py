"""Smoke-test the shipped CPython 3.9 wheels and broker over a disposable, private Unix socket."""

from http.client import HTTPResponse
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time


ROOT = Path("/opt/id-business-independent/releases/" + "1" * 40)
DESKTOP = ROOT / "source/deploy/manual-desktop"
PACKAGES = ROOT / "manual-runtime/site-packages"
sys.path[:0] = [str(DESKTOP), str(PACKAGES)]
from aiohttp import web
import broker
import egress


def response(path, route):
    with socket.socket(socket.AF_UNIX) as stream:
        stream.settimeout(4)
        stream.connect(str(path))
        stream.sendall(f"GET {route} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode("ascii"))
        with HTTPResponse(stream) as result:
            result.begin()
            return result.status, result.read()


def main():
    assert os.geteuid() == os.getegid() == 10001
    assert sys.version_info[:2] == (3, 9) and platform.machine() == "x86_64"
    assert Path(web.__file__).is_relative_to(PACKAGES)
    assert Path(broker.__file__).parent == Path(egress.__file__).parent == DESKTOP
    assert subprocess.check_output(["/usr/bin/rpm", "-q", "--qf", "%{VERSION}", "system-release"],
                                   text=True) == "2023.12.20260817"
    assert {dev.name for dev in Path("/sys/class/net").iterdir()
            if int((dev / "flags").read_text(), 16) & 1} == {"lo"}
    assets = ROOT / "manual-runtime/novnc"
    if sys.argv[1:2] == ["--serve"]:
        sys.argv = [str(DESKTOP / "broker.py"), *sys.argv[2:]]
        broker.main()
        return
    with_manager = sys.argv[1:] == ["--with-systemd"]
    assert with_manager == (Path("/proc/1/comm").read_text().strip() == "systemd")
    with TemporaryDirectory() as directory:
        base = Path(directory)
        for child in ("bridge", "workers", "claims", "inputs"):
            (base / child).mkdir(mode=0o700)
        path = base / "bridge/site.sock"
        process = subprocess.Popen([sys.executable, "-IBu", __file__, "--serve", "--socket", str(path),
                                    "--workers", str(base / "workers"), "--claims", str(base / "claims"),
                                    "--assets", str(assets), "--start-units", "--max-active", "1",
                                    "--min-available-mib", "512", "--recharge-input", str(base / "inputs"),
                                    "--recharge-block-network", "203.0.113.1/32"])
        try:
            deadline = time.monotonic() + 8
            while not path.is_socket():
                assert process.poll() is None, "broker_exited_before_binding"
                if time.monotonic() >= deadline:
                    raise TimeoutError("broker_socket_start_timeout")
                time.sleep(0.05)
            code, data = response(path, "/v1/client/core/rfb.js")
            assert code == 200 and data == (assets / "core/rfb.js").read_bytes()
            for route, key in (("renewal", "renewalWorkspace"), ("recharge", "rechargeBootstrap")):
                code, data = response(path, f"/v1/{route}/status")
                if with_manager:
                    assert code == 200 and json.loads(data) == {key: 1}, (route, code)
                else:
                    assert code == 503, (route, code)
        finally:
            process.terminate()
            process.wait(timeout=5)
        assert process.returncode == 0 and not path.exists(), "broker_unclean_shutdown"
        print(f"cp39_release_wheels=imported broker_uid=10001 asset=verified status={code} clean_exit=true")


if __name__ == "__main__":
    main()
