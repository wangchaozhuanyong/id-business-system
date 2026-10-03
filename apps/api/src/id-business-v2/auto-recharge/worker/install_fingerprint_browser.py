"""构建时安装已锁定且校验 SHA256 的官方内核；不在任务运行时调用。"""
import argparse
import hashlib
from pathlib import Path
import subprocess
import shutil
import tempfile
from urllib.request import urlopen

VERSION = '152.0.4-beta.30'
ASSETS = {
    'lin.x86_64': '5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672',
    'mac.arm64': '3b43e766574f286a6a63296cf58b660b7a3120952086c869b4df4c9a71604bc3'
}


def install(destination, platform):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='fingerprint-build-', dir=destination) as temporary:
        archive = Path(temporary) / 'engine.zip'
        url = f'https://github.com/daijro/camoufox/releases/download/v{VERSION}/camoufox-{VERSION}-{platform}.zip'
        digest = hashlib.sha256()
        with urlopen(url, timeout=60) as source, archive.open('wb') as target:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != ASSETS[platform]:
            raise RuntimeError('fingerprint_archive_digest_mismatch')
        subprocess.run(['unzip', '-q', str(archive), '-d', str(destination)], check=True)
    if platform == 'mac.arm64':
        # 0.5.6 的自定义执行路径从二进制旁读取属性；官方 macOS 包把它放在 Resources。
        app = destination / 'Camoufox.app' / 'Contents'
        shutil.copy2(app / 'Resources' / 'properties.json', app / 'MacOS' / 'properties.json')
    print(f'Installed Camoufox {VERSION}; SHA256 verified; {destination}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', required=True)
    parser.add_argument('--platform', choices=ASSETS, required=True)
    options = parser.parse_args()
    install(options.destination, options.platform)
