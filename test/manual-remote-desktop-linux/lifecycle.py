"""Give the disposable systemd lab the stop-and-wait semantics of a container runtime."""
from pathlib import Path
import signal
import subprocess
import sys
import time

runtime = Path("/run/workspace")
request = runtime / ".qa-stop"
done = runtime / ".qa-stopped"
if sys.argv[1] == "stop":
    # ExecStop may run in a different PID namespace from ExecStart.
    request.touch()
    deadline = time.monotonic() + 20
    while not done.exists() and time.monotonic() < deadline:
        time.sleep(.05)
    if not done.exists() or done.read_text() != "0":
        raise SystemExit("The worker did not report a clean exit")
    raise SystemExit(0)

for path in (request, done):
    path.unlink(missing_ok=True)
start = [sys.executable, "-IB"]
fixture = subprocess.Popen(start + ["/run/id-manual-qa/fixture.py"])
worker = subprocess.Popen(start + ["/run/id-manual-qa/worker.py"])
try:
    while worker.poll() is None:
        if request.exists():
            worker.send_signal(signal.SIGTERM)
            break
        time.sleep(.05)
    status = worker.wait()
finally:
    fixture.terminate()
    fixture.wait()
done.write_text(str(status))
raise SystemExit(status)
