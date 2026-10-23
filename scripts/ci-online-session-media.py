"""Install the existing CI media tools from Ubuntu's signed archive on an ephemeral runner."""
import os
from pathlib import Path
import platform
import shutil
import subprocess


def main():
    if shutil.which('ffmpeg') and shutil.which('ffprobe'):
        return
    if os.environ.get('GITHUB_ACTIONS') != 'true' or platform.system() != 'Linux':
        raise RuntimeError('MEDIA_INSTALL_REQUIRES_EPHEMERAL_GITHUB_RUNNER')
    source = Path('/etc/apt/sources.list.d/ubuntu.sources')
    raw = source.read_text()
    if 'azure.archive.ubuntu.com/ubuntu' not in raw:
        raise RuntimeError('UNEXPECTED_UBUNTU_APT_SOURCE')
    # Keep the distribution, components and Signed-By keyring; only change the mirror.
    directory = Path(__file__).resolve().parents[1] / '.runtime' / 'ci-online-session-media'
    directory.mkdir(parents=True, exist_ok=True)
    selected = directory / 'ubuntu.sources'
    selected.write_text(raw.replace('azure.archive.ubuntu.com/ubuntu', 'archive.ubuntu.com/ubuntu'))
    options = ['-o', 'Dir::Etc::sourcelist=' + str(selected), '-o', 'Dir::Etc::sourceparts=-',
               '-o', 'APT::Get::List-Cleanup=0', '-o', 'Acquire::Retries=2',
               '-o', 'Acquire::http::Timeout=30']
    subprocess.run(['sudo', 'apt-get', *options, 'update'], check=True, timeout=180)
    subprocess.run(['sudo', 'apt-get', *options, 'install', '-y', '--no-install-recommends', 'ffmpeg'],
                   check=True, timeout=300)


if __name__ == '__main__':
    main()
