"""Supervise one ordinary browser desktop. The host owns workspace assignment and egress."""

import asyncio
import fcntl
from importlib import util
import json
import os
from contextlib import ExitStack, contextmanager
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import unquote, urlsplit


PROFILE = Path("/profile")
RUNTIME = Path("/run/workspace")
SOCKET = RUNTIME / "rfb.sock"
STAGING_SOCKET = RUNTIME / ".starting.sock"
DISPLAY = ":1"
INPUT = Path("/run/workspace-input")


def check_container(mountinfo, status):
    if os.getpid() == 1:
        raise RuntimeError("工作区需要通过镜像的 tini 入口启动，以便正常退出并恢复网页")
    mounts = {}
    for line in mountinfo.splitlines():
        mount, fs = line.split(" - ", 1)
        fields = mount.split()
        mounts[fields[4]] = (fields[5].split(","), fs.split()[0])
    if "ro" not in mounts.get("/", ([], ""))[0] or any(
        "rw" not in mounts.get(path, ([], ""))[0] for path in ("/profile", "/run/workspace", "/tmp")
    ):
        raise RuntimeError("工作区需要只读系统盘、独立资料卷、显示套接字目录和临时盘")
    if mounts["/tmp"][1] != "tmpfs":
        raise RuntimeError("工作区的 /tmp 需要独占内存临时盘")
    flags = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    if (os.getuid() != 10001 or os.getgid() != 10001 or
            int(flags.get("CapEff", "-1"), 16) or int(flags.get("CapBnd", "-1"), 16) or
            int(flags.get("NoNewPrivs", "-1")) != 1 or int(flags.get("Seccomp", "-1")) != 2):
        raise RuntimeError("工作区需要专用非特权用户、空 capabilities、禁止提权和 seccomp 过滤")


def lock_directory(directory):
    fd = os.open(directory, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError("工作区挂载目录必须归运行用户所有，权限为 0700")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


def remove_owned_socket(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError("工作区显示套接字位置存在其他文件")
    path.unlink()


def display_command(socket_path):
    return [
        "/usr/bin/Xtigervnc", DISPLAY, "-geometry", "1280x800", "-depth", "24",
        "-desktop", "Chromium", "-nolisten", "tcp", "-noreset",
        "-rfbport", "-1", "-rfbunixpath", str(socket_path), "-rfbunixmode", "0600",
        "-SecurityTypes", "None", "-MaxDisconnectionTime", "0", "-NeverShared",
        "-AcceptCutText=0", "-SendCutText=0", "-SendPrimary=0", "-SetPrimary=0",
        "-AllowOverride=",
        "-FrameRate", "20",
    ]


def browser_command(proxy_port=None):
    # A startup URL on subsequent launches would add a tab to the restored session.
    args = [
        "/usr/lib/chromium/chromium", "--ozone-platform=x11", "--user-data-dir=/profile",
        "--restore-last-session", "--no-first-run", "--no-default-browser-check",
        "--start-maximized",
    ]
    if proxy_port is not None:
        if not 1 <= proxy_port <= 65535:
            raise RuntimeError("充值工作区代理不可用")
        args.extend([
            f"--proxy-server=http://127.0.0.1:{proxy_port}",
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ])
    if not (PROFILE / "Local State").exists():
        args.append("https://chatgpt.com/")
    return args


def stop_process(process, sig):
    if process.poll() is None:
        process.send_signal(sig)
    # Keep the display alive until the browser has actually finished writing its profile.
    process.wait()


def run_desktop(private_tmp, proxy_port=None, report_ready=None):
    auth = private_tmp / "Xauthority"
    auth.touch(mode=0o600)
    env = {
        "PATH": "/usr/bin:/bin", "HOME": str(PROFILE), "USER": "workspace",
        "LANG": "C.UTF-8", "DISPLAY": DISPLAY, "XAUTHORITY": str(auth),
        "XDG_RUNTIME_DIR": str(private_tmp),
    }
    subprocess.run(
        ["/usr/bin/xauth", "-f", str(auth), "source", "-"],
        input=f"add {DISPLAY} . {secrets.token_hex(16)}\n".encode(), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )
    stopping = False

    def request_stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    children = []
    with ExitStack() as cleanup:
        for sig in (signal.SIGINT, signal.SIGTERM):
            cleanup.callback(signal.signal, sig, signal.signal(sig, request_stop))

        def start(argv, exit_signal):
            child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            children.append(child)
            cleanup.callback(stop_process, child, exit_signal)
            return child

        def check_running(processes):
            for child in processes:
                code = child.poll()
                if code is not None:
                    raise RuntimeError(f"{Path(child.args[0]).name} 已退出（状态 {code}）")

        def wait_ready(check):
            deadline = time.monotonic() + 30
            while not stopping:
                check_running(children)
                if check():
                    return True
                if time.monotonic() >= deadline:
                    raise RuntimeError("桌面组件启动超时")
                time.sleep(0.1)
            return False

        def has_window():
            result = subprocess.run(
                ["/usr/bin/xprop", "-root", "_NET_CLIENT_LIST"], env=env,
                capture_output=True, timeout=3, check=False,
            )
            for window in re.findall(rb"\b0x[0-9a-f]+\b", result.stdout, re.IGNORECASE):
                props = subprocess.run(
                    ["/usr/bin/xprop", "-id", window.decode("ascii"), "WM_CLASS"],
                    env=env, capture_output=True, timeout=3, check=False,
                )
                # Match the WM_CLASS class (second string). Debian names its
                # visible window Chromium-browser and puts the profile in the instance.
                if props.returncode == 0 and re.search(
                    rb',\s*"chromium(?:-browser)?"\s*$', props.stdout, re.IGNORECASE,
                ):
                    return True
            return False

        start(display_command(STAGING_SOCKET) + ["-auth", str(auth)], signal.SIGTERM)
        if not wait_ready(STAGING_SOCKET.is_socket):
            return
        start(["/usr/bin/matchbox-window-manager", "-use_titlebar", "no"], signal.SIGTERM)
        browser = start(browser_command(proxy_port), signal.SIGINT)
        if not wait_ready(has_window):
            return
        if stat.S_IMODE(STAGING_SOCKET.lstat().st_mode) != 0o600:
            raise RuntimeError("工作区显示套接字权限无效")
        STAGING_SOCKET.rename(SOCKET)
        cleanup.callback(remove_owned_socket, SOCKET)
        if report_ready:
            report_ready()
        while not stopping:
            code = browser.poll()
            if code is not None:
                if code == 0:
                    return
                raise RuntimeError(f"Chromium 已退出（状态 {code}）")
            check_running(children[:-1])
            time.sleep(0.2)


def workspace_settings(source):
    try:
        line = source.readline(8193)
        if len(line) > 8192 or not line.endswith(b"\n"):
            raise ValueError
        data = json.loads(line)
        if data == {"mode": "renewal"}:
            return "renewal", None, None
        if not isinstance(data, dict) or set(data) != {"email", "proxyUrl", "expectedCountry"}:
            raise ValueError
        email, url, country = data["email"], data["proxyUrl"], data["expectedCountry"]
        if (not isinstance(email, str) or len(email) > 254 or
                not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or
                not isinstance(url, str) or len(url) > 2048 or
                not isinstance(country, str) or not re.fullmatch(r"(?:[A-Z]{2})?", country)):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme != "http" or not parsed.hostname or not parsed.port:
            raise ValueError
        username = unquote(parsed.username or "", errors="strict")
        password = unquote(parsed.password or "", errors="strict")
        if bool(username) != bool(password):
            raise ValueError
        return "recharge", ((username, password) if username else None), country
    except (ValueError, TypeError, UnicodeError):
        raise RuntimeError("工作区收到无效的代理启动资料") from None


@contextmanager
def workspace_proxy_context():
    if not INPUT.exists():
        yield None, None
        return
    if not os.statvfs(INPUT).f_flag & os.ST_RDONLY:
        raise RuntimeError("充值工作区启动目录需要只读挂载")

    spec = util.spec_from_file_location("manual_recharge_proxy", Path(__file__).with_name("recharge_proxy.py"))
    module = util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as bootstrap:
        bootstrap.settimeout(20)
        bootstrap.connect(str(INPUT / "bootstrap.sock"))
        with bootstrap.makefile("rb") as source:
            mode, authorization, expected_country = workspace_settings(source)
        loop = asyncio.new_event_loop()
        proxy = None
        runner = None
        try:
            proxy = loop.run_until_complete(asyncio.wait_for(
                module.open_proxy(authorization, relay_path=INPUT / "egress.sock", renewal=mode == "renewal"), 3))
            authorization = None
            if mode == "renewal":
                # Verify the local private relay is listening before publishing the desktop.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as relay:
                    relay.settimeout(3)
                    relay.connect(str(INPUT / "egress.sock"))
                receipt = {"mode": "renewal", "ready": True}
            else:
                exit_info = loop.run_until_complete(asyncio.wait_for(module.verify_exit(proxy, expected_country), 15))
                receipt = {"exitIp": exit_info["ip"], "country": exit_info["country"], "accountStatus": "check-in-browser"}
            runner = threading.Thread(target=loop.run_forever, daemon=True)
            runner.start()
        except Exception:
            if proxy:
                loop.run_until_complete(proxy.close())
            loop.close()
            if mode == "renewal":
                raise RuntimeError("续费工作区的网络连接服务不可用") from None
            raise RuntimeError("所选代理出口未通过核验") from None

        def report_ready():
            bootstrap.sendall(json.dumps(receipt, separators=(",", ":")).encode("ascii") + b"\n")
            bootstrap.close()

        try:
            yield proxy.port, report_ready
        finally:
            closing = asyncio.run_coroutine_threadsafe(proxy.close(), loop)
            try:
                closing.result(timeout=8)
            finally:
                loop.call_soon_threadsafe(loop.stop)
                runner.join(3)
                if not runner.is_alive():
                    loop.close()

def main():
    os.umask(0o077)
    check_container(Path("/proc/self/mountinfo").read_text(), Path("/proc/self/status").read_text())
    with ExitStack() as cleanup:
        for directory in (PROFILE, RUNTIME):
            cleanup.callback(os.close, lock_directory(directory))
        # Both directories are locked across startup, GUI use and clean shutdown.
        for path in (SOCKET, STAGING_SOCKET):
            remove_owned_socket(path)
            cleanup.callback(remove_owned_socket, path)
        private = cleanup.enter_context(tempfile.TemporaryDirectory(dir="/tmp", prefix="desktop-"))
        with workspace_proxy_context() as (port, report_ready):
            run_desktop(Path(private), port, report_ready)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        # Child command lines, visited pages and browser logs are private.
        print(str(error) if isinstance(error, RuntimeError) else "无法启动或关闭独立桌面",
              file=sys.stderr)
        sys.exit(1)
