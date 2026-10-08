"""Private, stdin-only transport for the two existing native MySQL fixtures."""
import json
import os
from pathlib import Path
import select
import shutil
import subprocess


def add_fixture_arguments(parser):
    parser.add_argument('--runtime', choices=['docker', 'native'], default='docker')
    parser.add_argument('--mysql-bin')
    parser.add_argument('--work-directory')


def validate_fixture_arguments(parser, args):
    if args.runtime == 'native':
        if not args.mysql_bin or not Path(args.mysql_bin).is_absolute():
            parser.error('Native fixtures require an absolute --mysql-bin')
        if args.work_directory and not Path(args.work_directory).is_absolute():
            parser.error('Native fixture output must be an absolute project directory')
    elif args.mysql_bin or args.work_directory:
        parser.error('Docker fixtures cannot mix native connection options')


class NativeMysqlFixture:
    def __init__(self, database, mysql_bin, work_directory=None):
        if database not in {'recharge_fixture', 'storage_retention_test'}:
            raise AssertionError('Native fixture database rejected')
        root = Path(__file__).resolve().parents[2]
        area = Path(work_directory) if work_directory else root / '.runtime/native-python-fixtures'
        if not area.is_absolute():
            raise AssertionError('Native fixture output rejected')
        area = Path(os.path.abspath(area))
        if not area.is_relative_to(root) or area == root:
            raise AssertionError('Native fixture output rejected')
        ancestor = area
        while not ancestor.exists():
            ancestor = ancestor.parent
        if ancestor.resolve() != ancestor or not ancestor.is_dir():
            raise AssertionError('Native fixture output ancestor rejected')
        area.mkdir(parents=True, exist_ok=True, mode=0o700)
        if area.resolve() != area or area.stat().st_uid != os.getuid() or area.stat().st_mode & 0o022:
            raise AssertionError('Native fixture output identity rejected')
        self.process = None
        self.ready = False
        self.cleaned = False
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT'] if key in os.environ}
        node = shutil.which('node', path=env.get('PATH'))
        if not node:
            raise AssertionError('Native fixture Node unavailable')
        self.process = subprocess.Popen(
            [node, str(root / 'scripts/lib/native-mysql-fixture-bridge.mjs'),
             '--database=' + database, '--mysql-bin=' + str(mysql_bin), '--work-directory=' + str(area)],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        try:
            result = self._read()
            if result.get('ready') is not True or result.get('tcpDisabled') is not True:
                raise AssertionError('Native fixture startup failed; private output suppressed')
            self.ready = True
            self.version = result['mysqlVersion']
        except BaseException:
            self.close()
            raise

    def _read(self):
        if not select.select([self.process.stdout], [], [], 180)[0]:
            raise AssertionError('Native fixture transport timeout')
        line = self.process.stdout.readline(1024 * 1024 + 65536)
        if not line or len(line) > 1024 * 1024 + 65535:
            raise AssertionError('Native fixture transport response rejected')
        try:
            value = json.loads(line)
        except (ValueError, TypeError):
            raise AssertionError('Native fixture transport response rejected') from None
        if not isinstance(value, dict):
            raise AssertionError('Native fixture transport response rejected')
        return value

    def execute(self, statement, user='root', password=None):
        request = {'op': 'query', 'sql': statement, 'user': user}
        if password is not None:
            request['password'] = password
        try:
            self.process.stdin.write(json.dumps(request) + '\n')
            self.process.stdin.flush()
            value = self._read()
            code = value.get('mysqlCode')
            if type(value.get('returncode')) is not int or (code is not None and type(code) is not int):
                raise AssertionError('Native fixture transport response rejected')
            output = value.get('stdout', '')
            if not isinstance(output, str):
                raise AssertionError('Native fixture transport response rejected')
            # Preserve the original expected-error assertions without returning client diagnostics.
            error = 'ERROR ' + str(code) + ' (' if code is not None else ''
            return subprocess.CompletedProcess(['native-mysql-fixture'], value['returncode'], output, error)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.process is None:
            return
        process, self.process = self.process, None
        if process.poll() is None:
            try:
                process.stdin.write('{"op":"close"}\n')
                process.stdin.flush()
                process.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
        # Only a finite cleanup acknowledgment is inspected; no fixture values are logged.
        remaining = process.stdout.read(65536)
        self.cleaned = any(
            line == '{"closed":true,"cleanup":true}' for line in remaining.splitlines())
        process.stdout.close()
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
        if not self.cleaned:
            raise AssertionError('Native fixture cleanup not confirmed')
