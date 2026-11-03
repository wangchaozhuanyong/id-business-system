"""Mac/Windows 一次性后台启动设置。默认仅准备；--apply 才注册并启动。"""
from __future__ import annotations
import argparse
import importlib.metadata
import hashlib
import json
import locale
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler
from xml.etree import ElementTree as ET
from uuid import UUID

PROJECT = Path(__file__).resolve().parents[6]
LABEL = 'com.wangchao.id-business-v2-auto-recharge-connector'
WINDOWS_TASK = 'IDBusinessBitbrowserRecharge'


class SetupError(Exception):
    pass


def server_origin(value):
    parsed = urlsplit(str(value))
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise SetupError('配对文件的网站地址无效')
    return parsed.scheme + '://' + parsed.netloc


def option(args, key):
    for index, value in enumerate(args):
        if value == key and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(key + '='):
            return value.split('=', 1)[1]
    return None


def existing_mac(home):
    path = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    if path.is_symlink():
        raise SetupError('现有后台启动配置不是普通文件')
    if not path.exists():
        return path, None
    value = plistlib.loads(path.read_bytes())
    args = value.get('ProgramArguments', [])
    if value.get('Label') != LABEL or not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise SetupError('现有后台启动配置不属于充值助手')
    return path, value


def private_folder(path):
    if path.is_symlink() or path.parent.is_symlink():
        raise SetupError('运行目录不能是快捷链接')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != 'nt':
        path.chmod(0o700)


def atomic_private(path, content):
    if path.is_symlink():
        raise SetupError('不能覆盖快捷链接')
    fd, temporary = tempfile.mkstemp(prefix='.setup-', dir=path.parent)
    try:
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load_pairing(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 8192:
        raise SetupError('请选择网站下载的电脑配对文件')
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError, OSError):
        raise SetupError('电脑配对文件无法读取') from None
    if not isinstance(value, dict) or not value.get('pairingToken') or set(value) != {'serverUrl', 'pairingToken'}:
        raise SetupError('请选择本次新生成的电脑配对文件')
    origin = server_origin(value['serverUrl'])
    token = value['pairingToken']
    if not isinstance(token, str) or not 32 <= len(token) <= 200 or not all(c.isalnum() or c in '_-' for c in token):
        raise SetupError('电脑配对凭据无效')
    return {'serverUrl': origin, 'pairingToken': token}


def native_run(args, **kwargs):
    try:
        result = subprocess.run(args, capture_output=True, timeout=120, **kwargs)
        def decoded(value):
            if value.startswith((b'\xff\xfe', b'\xfe\xff')):
                return value.decode('utf-16')
            try:
                return value.decode('utf-8')
            except UnicodeError:
                return value.decode(locale.getpreferredencoding(False), errors='replace')
        return subprocess.CompletedProcess(result.args, result.returncode, decoded(result.stdout), decoded(result.stderr))
    except (OSError, subprocess.SubprocessError):
        raise SetupError('本机设置操作未完成，原任务与凭据已保留') from None


def check_idle(port, origin):
    import socket
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            pass
    except ConnectionRefusedError:
        return False
    except OSError:
        raise SetupError('无法确认充值助手状态，请稍后再试') from None
    try:
        request = Request(f'http://127.0.0.1:{port}/health', headers={'Origin': origin})
        with build_opener(ProxyHandler({})).open(request, timeout=3) as response:
            value = json.loads(response.read(8192))
        if value.get('service') != 'id-business-v2-auto-recharge-connector' or value.get('busy') is not False:
            raise SetupError('助手正在执行任务或端口被占用，请完成原任务后再设置')
        return True
    except SetupError:
        raise
    except Exception:
        raise SetupError('无法核对现有助手，未停止任何进程') from None


def windows_task_xml(python, runner, args, root, identity):
    ns = 'http://schemas.microsoft.com/windows/2004/02/mit/task'
    ET.register_namespace('', ns)
    task = ET.Element('{' + ns + '}Task', {'version': '1.2'})
    def child(parent, name, value=None, attributes=None):
        node = ET.SubElement(parent, '{' + ns + '}' + name, attributes or {})
        if value is not None:
            node.text = value
        return node
    trigger = child(child(task, 'Triggers'), 'LogonTrigger')
    child(trigger, 'Enabled', 'true'); child(trigger, 'UserId', identity)
    principal = child(child(task, 'Principals'), 'Principal', attributes={'id': 'CurrentUser'})
    child(principal, 'UserId', identity); child(principal, 'LogonType', 'InteractiveToken')
    child(principal, 'RunLevel', 'LeastPrivilege')
    settings = child(task, 'Settings')
    for name, value in [('MultipleInstancesPolicy', 'IgnoreNew'), ('DisallowStartIfOnBatteries', 'false'),
            ('StopIfGoingOnBatteries', 'false'), ('StartWhenAvailable', 'true'), ('ExecutionTimeLimit', 'PT0S')]:
        child(settings, name, value)
    restart = child(settings, 'RestartOnFailure')
    child(restart, 'Interval', 'PT1M'); child(restart, 'Count', '999')
    action = child(child(task, 'Actions', attributes={'Context': 'CurrentUser'}), 'Exec')
    child(action, 'Command', str(python)); child(action, 'Arguments', subprocess.list2cmdline([str(runner), *args]))
    child(action, 'WorkingDirectory', str(root))
    return ET.tostring(task, encoding='utf-16', xml_declaration=True)


def build_plan(root, home, platform, origin, python):
    if platform not in ('darwin', 'win32'):
        raise SetupError('目前支持 Mac 和 Windows 后台启动')
    origin = server_origin(origin)
    runtime = root / '.runtime/bitbrowser-recharge-assistant'
    if runtime.is_symlink() or not runtime.resolve().is_relative_to(root.resolve()):
        raise SetupError('运行目录必须位于本项目内')
    runner = root / 'apps/api/src/id-business-v2/online-recharge/connector/background_runner.py'
    if not runner.is_file():
        raise SetupError('所选文件夹缺少新版充值助手')
    target, previous = existing_mac(home) if platform == 'darwin' else (None, None)
    prior_args = previous.get('ProgramArguments', []) if previous else []
    if previous and (len(prior_args) < 2 or not Path(prior_args[1]).resolve().is_relative_to(root.resolve())):
        raise SetupError('现有后台助手属于其他项目，未更改')
    port = option(prior_args, '--port') or '55322'
    if not str(port).isdigit() or not 1024 <= int(port) <= 65535:
        raise SetupError('原助手端口无效')
    token_file = option(prior_args, '--token-file') or str(runtime / 'connector.token')
    origins = {origin}
    for index, value in enumerate(prior_args):
        if value.startswith('--allowed-origin='):
            origins.add(server_origin(value.split('=', 1)[1]))
        elif value == '--allowed-origin' and index + 1 < len(prior_args):
            origins.add(server_origin(prior_args[index + 1]))
    args = ['--role=recharge', '--port=' + str(port), '--token-file=' + token_file,
        '--online-config-file=' + str(runtime / 'device.json')]
    for value in sorted(origins):
        args.append('--allowed-origin=' + value)
    program = Path(python)
    if platform == 'win32':
        background = program.with_name('pythonw.exe')
        if not background.is_file():
            raise SetupError('需要包含 pythonw.exe 的 Python 3.11 或以上环境')
        program = background
    payload = {'Label': LABEL, 'ProgramArguments': [str(program), str(runner), *args],
        'WorkingDirectory': str(root), 'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
        'ProcessType': 'Background'}
    return {'root': root, 'runtime': runtime, 'runner': runner, 'python': program, 'args': args,
        'origin': origin, 'port': int(port), 'target': target, 'previous': previous, 'plist': payload,
        'platform': platform}


def apply_plan(plan, pairing, *, run=native_run, idle=check_idle, pair_client=None):
    # 准备依赖与服务器配对均在停止原助手之前完成。
    present = idle(plan['port'], plan['origin'])
    if plan['platform'] == 'darwin':
        domain = 'gui/' + str(os.getuid())
        loaded = run(['/bin/launchctl', 'print', domain + '/' + LABEL]).returncode == 0
        if present and not loaded:
            raise SetupError('已有手动启动的助手，请先退出空闲助手再设置，未启动第二个进程')
        existing = None
    else:
        existing = run(['schtasks', '/Query', '/TN', WINDOWS_TASK, '/XML'])
        if existing.returncode == 0:
            try:
                directory = ET.fromstring(existing.stdout).findtext('.//{*}WorkingDirectory')
                if str(directory).casefold() != str(plan['root']).casefold():
                    raise ValueError('foreign task')
            except (ET.ParseError, ValueError):
                raise SetupError('同名后台任务属于其他位置或无法核对，未覆盖') from None
        elif present:
            raise SetupError('已有手动启动的助手，请先退出空闲助手再设置，未启动第二个进程')
    runtime = plan['runtime']
    private_folder(runtime)
    config = runtime / 'device.json'
    reused_binding = False
    if config.exists():
        if config.is_symlink():
            raise SetupError('本机绑定文件不是普通文件，未覆盖')
        try:
            previous = json.loads(config.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError):
            raise SetupError('本机绑定文件需要核对，未覆盖原文件') from None
        if not isinstance(previous, dict) or previous.get('serverUrl') != pairing['serverUrl']:
            raise SetupError('本机已有其他网站绑定，未覆盖已有凭据')
        if previous.get('deviceKey'):
            try:
                UUID(previous.get('deviceId', ''))
                key = previous['deviceKey']
                if not isinstance(key, str) or not 32 <= len(key) <= 200:
                    raise ValueError('invalid device credential')
            except (ValueError, TypeError, AttributeError):
                raise SetupError('本机已有电脑绑定需要核对，未覆盖已有凭据') from None
            reused_binding = True
    if not reused_binding:
        atomic_private(config, json.dumps(pairing).encode())
    try:
        if plan['platform'] == 'win32':
            identity = run(['whoami']).stdout.strip()
            if not identity or run(['icacls', str(runtime), '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F']).returncode:
                raise SetupError('无法限制本机凭据目录访问权限')
            if run(['icacls', str(config), '/inheritance:r', '/grant:r', identity + ':F']).returncode:
                raise SetupError('无法限制本机凭据文件访问权限')
        if pair_client is None:
            from online_bitbrowser_agent import RpcClient
            pair_client = RpcClient
        client = pair_client(config)
        if reused_binding:
            # 只读验证原设备身份；安装恢复不兑换新凭据、不重绑其他电脑。
            connection = client.rpc('connection')
            if not isinstance(connection, dict):
                raise SetupError('原电脑绑定验证未完成')
            connection.clear()
    except Exception:
        # 保留未使用的受限配置以便排查；不停止原助手或打印远端响应。
        raise SetupError('电脑配对未完成，原助手继续运行，请检查网站版本和配对期限') from None
    idle(plan['port'], plan['origin'])
    if plan['platform'] == 'darwin':
        target = plan['target']
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        candidate = plistlib.dumps(plan['plist'])
        atomic_private(runtime / 'background.plist', candidate)
        original = target.read_bytes() if target.exists() else None
        if loaded and run(['/bin/launchctl', 'bootout', domain + '/' + LABEL]).returncode:
            raise SetupError('无法安全切换原助手，未启动第二个助手')
        try:
            atomic_private(target, candidate)
            if run(['/bin/launchctl', 'bootstrap', domain, str(target)]).returncode:
                raise SetupError('后台启动未完成')
        except Exception:
            if original is not None:
                atomic_private(target, original)
                if loaded:
                    run(['/bin/launchctl', 'bootstrap', domain, str(target)])
            raise SetupError('后台启动未完成，已保留或恢复原启动配置') from None
    else:
        identity = run(['whoami']).stdout.strip()
        candidate = runtime / 'background-task.xml'
        atomic_private(candidate, windows_task_xml(plan['python'], plan['runner'], plan['args'], plan['root'], identity))
        if present and existing is not None and existing.returncode == 0:
            if run(['schtasks', '/End', '/TN', WINDOWS_TASK]).returncode:
                raise SetupError('无法安全切换原后台助手，未启动第二个进程')
        if run(['schtasks', '/Create', '/TN', WINDOWS_TASK, '/XML', str(candidate), '/F']).returncode:
            if existing is not None and existing.returncode == 0:
                original_xml = runtime / 'previous-background-task.xml'
                atomic_private(original_xml, existing.stdout.encode('utf-16'))
                run(['schtasks', '/Create', '/TN', WINDOWS_TASK, '/XML', str(original_xml), '/F'])
                if present:
                    run(['schtasks', '/Run', '/TN', WINDOWS_TASK])
            raise SetupError('Windows 后台启动设置未完成')
        if run(['schtasks', '/Run', '/TN', WINDOWS_TASK]).returncode:
            raise SetupError('已保存登录自启动，请重新登录电脑后在网站核对状态')
    return {'configured': True, 'online': '请回网站刷新确认', 'platform': plan['platform'],
        'reusedBinding': reused_binding}


def choose_pairing():
    if sys.platform == 'darwin':
        result = native_run(['/usr/bin/osascript', '-e', 'POSIX path of (choose file with prompt "选择网站下载的电脑配对文件")'])
        if result.returncode:
            raise SetupError('已取消设置')
        return Path(result.stdout.strip())
    import tkinter
    from tkinter.filedialog import askopenfilename
    app = tkinter.Tk(); app.withdraw()
    value = askopenfilename(title='选择网站下载的电脑配对文件', filetypes=[('电脑配对文件', '*.json')])
    app.destroy()
    if not value:
        raise SetupError('已取消设置')
    return Path(value)


def ensure_runtime(root, run=native_run):
    requirements = root / 'apps/api/src/id-business-v2/auto-recharge/worker/requirements-bitbrowser.lock.txt'
    versions = dict(line.split('==', 1) for line in requirements.read_text().splitlines() if '==' in line and not line.startswith('#'))
    try:
        if all(importlib.metadata.version(name) == version for name, version in versions.items()):
            return Path(sys.executable)
    except importlib.metadata.PackageNotFoundError:
        pass
    # 使用独立版本目录，准备新环境时不改正在运行的旧助手。
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()[:16]
    folder = root / '.runtime/bitbrowser-recharge-assistant/environments' / digest
    if not folder.resolve().is_relative_to(root.resolve()):
        raise SetupError('运行环境必须位于本项目内')
    private_folder(folder.parent)
    if folder.is_symlink():
        raise SetupError('运行环境目录不能是快捷链接')
    python = folder / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file() and run([sys.executable, '-m', 'venv', str(folder)]).returncode:
        raise SetupError('一次性运行环境准备未完成，原助手继续运行')
    if run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(requirements)]).returncode:
        raise SetupError('首次依赖下载未完成，请检查网络后重试；原助手继续运行')
    if run([str(python), '-m', 'pip', 'check']).returncode:
        raise SetupError('运行环境检查未通过，未切换原助手')
    return python


def main():
    parser = argparse.ArgumentParser(description='充值助手一次性后台设置')
    parser.add_argument('--pairing-file')
    parser.add_argument('--origin')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--interactive', action='store_true')
    options = parser.parse_args()
    try:
        if sys.version_info < (3, 11):
            raise SetupError('需要 Python 3.11 或以上版本')
        pairing = load_pairing(Path(options.pairing_file)) if options.pairing_file else (
            load_pairing(choose_pairing()) if options.interactive else None)
        origin = pairing['serverUrl'] if pairing else options.origin
        if not origin:
            raise SetupError('请先在网站生成本台电脑的配对文件')
        python = ensure_runtime(PROJECT) if options.apply else Path(sys.executable)
        plan = build_plan(PROJECT, Path.home(), sys.platform, origin, python)
        if options.apply:
            if pairing is None:
                raise SetupError('首次设置需要本台电脑的配对文件')
            result = apply_plan(plan, pairing)
            if result['reusedBinding']:
                print('已保留并复用本机原电脑绑定，未使用新的配对凭据。')
            print('后台启动已配置。以后登录电脑后自动运行，日常只需操作网站。')
        else:
            runtime = PROJECT / '.runtime/online-bitbrowser-website-only-20261103'
            private_folder(runtime)
            atomic_private(runtime / 'background-candidate.plist', plistlib.dumps(plan['plist']))
            print('只准备了后台启动配置，未安装、配对或启动助手。')
    except (SetupError, OSError, ValueError, ImportError) as error:
        print(str(error) if isinstance(error, SetupError) else '设置未完成，请核对本机安装环境。')
        raise SystemExit(2) from None


if __name__ == '__main__':
    main()
