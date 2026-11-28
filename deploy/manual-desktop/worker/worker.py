"""Supervise one ordinary browser desktop. The host owns workspace assignment and egress."""

import asyncio
import fcntl
from importlib import util
import json
import ipaddress
import os
from contextlib import ExitStack, contextmanager
from pathlib import Path
import re
import secrets
import select
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


def display_command(socket_path, shared=False):
    return [
        "/usr/bin/Xtigervnc", DISPLAY, "-geometry", "1280x800", "-depth", "24",
        "-desktop", "Chromium", "-nolisten", "tcp", "-noreset",
        "-rfbport", "-1", "-rfbunixpath", str(socket_path), "-rfbunixmode", "0600",
        "-SecurityTypes", "None", "-MaxDisconnectionTime", "0", "-AlwaysShared" if shared else "-NeverShared",
        "-AcceptCutText=0", "-SendCutText=0", "-SendPrimary=0", "-SetPrimary=0",
        "-AllowOverride=",
        "-FrameRate", "20",
    ]


def browser_command(proxy_port=None, verify_first=False):
    # A startup URL on subsequent launches would add a tab to the restored session.
    args = [
        "/usr/lib/chromium/chromium", "--ozone-platform=x11", "--user-data-dir=/profile",
        "--no-startup-window" if verify_first else "--restore-last-session",
        "--no-first-run", "--no-default-browser-check",
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
    if not verify_first and not (PROFILE / "Local State").exists():
        args.append("https://chatgpt.com/")
    return args


def stop_process(process, sig):
    if process.poll() is None:
        process.send_signal(sig)
    # Keep the display alive until the browser has actually finished writing its profile.
    process.wait()


class BrowserProof:
    """A private pipe to the running Chromium. Only the fixed IP-check target is inspected."""
    def __init__(self, proxy, loop, module, config):
        self.proxy = proxy
        self.loop = loop
        self.module = module
        self.config = config
        self.lock = threading.Lock()
        self.sequence = 0
        self.buffer = b''

    def start(self, argv, env, cleanup):
        # Chrome reads fd 3 and writes fd 4. Set them up after exec of a small
        # launcher instead of using preexec_fn in our multithreaded worker.
        from_browser, child_write = os.pipe()
        try:
            child_read, to_browser = os.pipe()
        except BaseException:
            os.close(from_browser)
            os.close(child_write)
            raise
        self.reader, self.writer = from_browser, to_browser
        cleanup.callback(os.close, from_browser)
        cleanup.callback(os.close, to_browser)
        launcher = ("import os,sys,fcntl; "
                    "r,w=[fcntl.fcntl(int(n),fcntl.F_DUPFD_CLOEXEC,5) for n in sys.argv[1:3]]; "
                    "os.close(int(sys.argv[1])); os.close(int(sys.argv[2])); "
                    "os.dup2(r,3); os.dup2(w,4); os.execv(sys.argv[3],sys.argv[3:])")
        try:
            return subprocess.Popen([sys.executable, '-IB', '-c', launcher, str(child_read), str(child_write),
                                     argv[0], '--remote-debugging-pipe', *argv[1:]], env=env,
                                    pass_fds=(child_read, child_write), stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        finally:
            os.close(child_read)
            os.close(child_write)

    def command(self, method, params, deadline, session=None):
        self.sequence += 1
        request = dict(id=self.sequence, method=method, params=params)
        if session:
            request['sessionId'] = session
        os.write(self.writer, json.dumps(request).encode() + b'\0')
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError()
            if b'\0' not in self.buffer:
                if not select.select([self.reader], [], [], max(0, deadline-time.monotonic()))[0]:
                    raise TimeoutError()
                block = os.read(self.reader, 65536)
                if not block or len(self.buffer) + len(block) > 2_000_000:
                    raise ValueError()
                self.buffer += block
                continue
            message, self.buffer = self.buffer.split(b'\0', 1)
            reply = json.loads(message)
            if reply.get('id') == self.sequence:
                return reply['result']

    def verify(self, first=False):
        with self.lock:
            deadline = time.monotonic() + 12
            target = self.command('Target.createTarget', {'url': 'about:blank', 'background': True}, deadline)['targetId']
            retained = False
            try:
                session = self.command('Target.attachToTarget', {'targetId': target, 'flatten': True}, deadline)['sessionId']
                self.command('Network.enable', {}, deadline, session)
                self.command('Network.setCacheDisabled', {'cacheDisabled': True}, deadline, session)
                self.command('Network.setBypassServiceWorker', {'bypass': True}, deadline, session)
                url = 'https://' + self.module.PROBE_HOST + '/?check=' + secrets.token_hex(10)
                navigated = self.command('Page.navigate', {'url': url}, deadline, session)
                if navigated.get('errorText'):
                    raise ValueError()
                expression = ('location.href === ' + json.dumps(url)
                              + ' && document.readyState === "complete" && document.querySelector("pre")?.innerText')
                while time.monotonic() < deadline:
                    found = self.command('Runtime.evaluate', {'expression': expression, 'returnByValue': True},
                                         deadline, session)['result'].get('value')
                    if isinstance(found, str) and found:
                        if len(found) > 4096:
                            raise ValueError()
                        value = self.module._validated_exit(json.loads(found), self.config['expectedCountry'])
                        if ipaddress.ip_address(value['ip']) != ipaddress.ip_address(self.config['expectedIp']):
                            raise ValueError()
                        if first:
                            self.startup_target = target
                            retained = True
                        return {'exitIp': value['ip'], 'country': value['country'], 'accountStatus': 'check-in-browser'}
                    time.sleep(.05)
                raise TimeoutError()
            finally:
                if not retained:
                    self.command('Target.closeTarget', {'targetId': target}, time.monotonic()+1)

    def publish(self, cleanup):
        # No debugging socket is exposed. The broker can request only a fresh
        # receipt for this generation on the worker's private attestation socket.
        path = RUNTIME / 'probe.sock'
        remove_owned_socket(path)
        async def attest(reader, writer):
            try:
                line = await asyncio.wait_for(reader.readline(), 2)
                if line != (self.config['runId'] + '\n').encode():
                    return
                receipt = await asyncio.to_thread(self.verify)
                writer.write(json.dumps(receipt).encode() + b'\n')
                await writer.drain()
            except (OSError, ValueError, KeyError, asyncio.TimeoutError):
                pass
            finally:
                writer.close()
        async def listen():
            server = await asyncio.start_unix_server(attest, path=path, limit=256)
            os.chmod(path, 0o600)
            self.proxy.admit_browser()
            return server
        server = asyncio.run_coroutine_threadsafe(listen(), self.loop).result(3)
        cleanup.callback(remove_owned_socket, path)
        cleanup.callback(self.loop.call_soon_threadsafe, server.close)
        if getattr(self, 'startup_target', None):
            # Keep the original profile and its login cookies, but never restore pages
            # from a previous run before this Chromium has attested its new route.
            with self.lock:
                self.command('Target.createTarget', {'url': 'https://chatgpt.com/'}, time.monotonic()+5)
                self.command('Target.closeTarget', {'targetId': self.startup_target}, time.monotonic()+2)
                self.startup_target = None


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

        start(display_command(STAGING_SOCKET, shared=isinstance(proxy_port, BrowserProof)) + ["-auth", str(auth)], signal.SIGTERM)
        if not wait_ready(STAGING_SOCKET.is_socket):
            return
        start(["/usr/bin/matchbox-window-manager", "-use_titlebar", "no"], signal.SIGTERM)
        if isinstance(proxy_port, BrowserProof):
            browser = proxy_port.start(browser_command(proxy_port.proxy.port, verify_first=True), env, cleanup)
            children.append(browser)
            cleanup.callback(stop_process, browser, signal.SIGINT)
            try:
                receipt = proxy_port.verify(first=True)
                proxy_port.publish(cleanup)
            except (OSError, KeyError, ValueError, TimeoutError):
                raise RuntimeError('浏览器实际出口与测速结果不匹配或无法核实') from None
        else:
            browser = start(browser_command(proxy_port), signal.SIGINT)
        if not wait_ready(has_window):
            return
        if stat.S_IMODE(STAGING_SOCKET.lstat().st_mode) != 0o600:
            raise RuntimeError("工作区显示套接字权限无效")
        STAGING_SOCKET.rename(SOCKET)
        cleanup.callback(remove_owned_socket, SOCKET)
        if report_ready:
            report_ready(receipt) if isinstance(proxy_port, BrowserProof) else report_ready()
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
            return "renewal", None, None, None
        base = {"email", "proxyUrl", "expectedCountry"}
        if not isinstance(data, dict) or set(data) not in (base, base | {'id', 'runId', 'expectedIp'}):
            raise ValueError
        email, url, country = data["email"], data["proxyUrl"], data["expectedCountry"]
        if (not isinstance(email, str) or len(email) > 254 or
                not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or
                not isinstance(url, str) or len(url) > 2048 or
                not isinstance(country, str) or not re.fullmatch(r"(?:[A-Z]{2})?", country)):
            raise ValueError
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https", "socks", "socks4", "socks5", "socks5h") or not parsed.hostname or not parsed.port:
            raise ValueError
        username = unquote(parsed.username or "", errors="strict")
        password = unquote(parsed.password or "", errors="strict")
        if (parsed.scheme == "socks4" and password) or (
                parsed.scheme != "socks4" and bool(username) != bool(password)):
            raise ValueError
        binding = None
        if 'runId' in data:
            if not isinstance(data['runId'], str) or not re.fullmatch(r'[0-9a-f-]{36}', data['runId']):
                raise ValueError
            if not country or not ipaddress.ip_address(data['expectedIp']).is_global:
                raise ValueError
            binding = {k: data[k] for k in ('runId', 'expectedCountry', 'expectedIp')}
        credentials = (username, password) if username and parsed.scheme in ("http", "https") else None
        return "recharge", credentials, country, binding
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
            mode, authorization, expected_country, binding = workspace_settings(source)
        loop = asyncio.new_event_loop()
        proxy = None
        runner = None
        try:
            proxy = loop.run_until_complete(asyncio.wait_for(
                module.open_proxy(authorization, relay_path=INPUT / "egress.sock", renewal=mode == "renewal",
                                  verify_browser=binding is not None), 3))
            authorization = None
            if mode == "renewal":
                # Verify the local private relay is listening before publishing the desktop.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as relay:
                    relay.settimeout(3)
                    relay.connect(str(INPUT / "egress.sock"))
                receipt = {"mode": "renewal", "ready": True}
            elif binding:
                receipt = None
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

        def report_ready(proof=None):
            bootstrap.sendall(json.dumps(proof or receipt, separators=(",", ":")).encode("ascii") + b"\n")
            bootstrap.close()

        try:
            yield BrowserProof(proxy, loop, module, binding) if binding else proxy.port, report_ready
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
