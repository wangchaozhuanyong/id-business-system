"""Verify normal file visibility as the worker user inside both real QA sessions."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


def probe(own, other, neighbor_pid):
    assert (Path("/profile") / "qa-sentinel").read_text() == own
    assert Path("/proc/self/root/profile/qa-sentinel").read_text() == own
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(3)
        connection.connect("/run/workspace/rfb.sock")
        assert connection.recv(12).startswith(b"RFB ")
    try:
        os.listdir("/run/id-manual-qa/claims")
    except (FileNotFoundError, PermissionError):
        pass
    else:
        raise AssertionError("worker must not list broker claims")
    forbidden = [
        f"/run/id-manual-qa/profiles/{other}/qa-sentinel",
        f"/run/id-manual-qa/workers/{other}/rfb.sock",
        "/run/id-manual-qa/broker/web.sock", "/home/qa", "/mnt/qa/jobs",
        f"/proc/{neighbor_pid}/root/profile/qa-sentinel",
        f"/proc/{neighbor_pid}/root/run/workspace/rfb.sock",
    ]
    for item in forbidden:
        try:
            os.stat(item)
        except (FileNotFoundError, PermissionError):
            continue
        raise AssertionError("unexpected QA path visible inside the worker: " + item)
    print(json.dumps({"own_profile_readable": True, "own_socket_readable": True, "broker_claims_inaccessible": True,
                      "hidden_neighbor_and_host_targets": len(forbidden)}))


def inspect_workers(keys):
    pids = [subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value",
            "id-manual-workspace@" + key + ".service"], text=True).strip() for key in keys]
    assert all(pid.isdigit() and int(pid) > 1 for pid in pids)
    namespaces = {kind: [os.readlink(f"/proc/{pid}/ns/{kind}") for pid in pids]
                  for kind in ("mnt", "pid", "net")}
    assert all(len(set(ids)) == 2 for ids in namespaces.values())
    for key in keys:
        marker = Path("/run/id-manual-qa/profiles", key, "qa-sentinel")
        marker.write_text(key)
        os.chown(marker, 10001, 10001)
        marker.chmod(0o600)
    records = []
    for index, (key, pid) in enumerate(zip(keys, pids)):
        command = ["nsenter", "-t", pid, "-m", "-n", "-p", "--", "setpriv", "--reuid", "10001",
                   "--regid", "10001", "--clear-groups", "--bounding-set=-all",
                   "--no-new-privs", "/usr/bin/python3", "-IB", "/run/id-manual-qa/isolation.py",
                   "probe", key, keys[1 - index], pids[1 - index]]
        records.append(json.loads(subprocess.check_output(command, text=True)))
    print(json.dumps({"unique_namespaces": list(namespaces), "workers": records}))


if sys.argv[1] == "probe":
    probe(*sys.argv[2:])
else:
    inspect_workers(sys.argv[1:])
