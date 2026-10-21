#!/usr/bin/env python3
"""Install/restore the QQ 3.2.34 notification patch without touching user data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

FILES = ('qq_main_hook.js', 'qq-notifier-main.js', 'qq-notifier-preload.js')
ORIGINAL_MAIN = './application.asar/app_launcher/index.js'
PATCHED_MAIN = './qq_main_hook.js'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def atomic(path, data, mode=0o644):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Installer:
    def __init__(self, qqdir, source):
        self.qqdir = Path(qqdir)
        self.source = Path(source)
        self.package = self.qqdir / 'package.json'
        self.state = self.qqdir / 'qq-notify-patch.state.json'
        self.backups = self.qqdir / '.qq-notify-patch-backups'
        self.uid = os.geteuid()

    def read_owned(self, path):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('不是普通文件，停止：' + str(path))
        metadata = path.stat()
        if metadata.st_uid != self.uid or metadata.st_mode & 0o022:
            raise RuntimeError('文件所有者或写入权限异常：' + str(path))
        return path.read_bytes()

    def ensure_stopped(self):
        executable = self.qqdir.parent.parent / 'qq'
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if os.readlink(entry / 'exe').removesuffix(' (deleted)') == str(executable):
                    raise RuntimeError('请先从托盘完全退出 QQ；没有修改文件。')
            except OSError:
                continue

    def prepare(self):
        if self.qqdir.is_symlink() or not self.qqdir.is_dir():
            raise RuntimeError('QQ 安装目录不存在或是符号链接。')
        if self.qqdir.stat().st_uid != self.uid or self.qqdir.stat().st_mode & 0o022:
            raise RuntimeError('QQ 安装目录权限异常。')
        self.ensure_stopped()
        return self.read_owned(self.package)

    def archive(self, package, files, state=None):
        if self.backups.is_symlink():
            raise RuntimeError('备份目录不能是符号链接。')
        self.backups.mkdir(mode=0o700, exist_ok=True)
        if self.backups.stat().st_uid != self.uid or stat.S_IMODE(self.backups.stat().st_mode) != 0o700:
            raise RuntimeError('备份目录所有者或权限异常。')
        backup = Path(tempfile.mkdtemp(prefix='backup-', dir=self.backups))
        atomic(backup / 'package.json', package, 0o600)
        for name, data in files.items():
            atomic(backup / name, data, 0o600)
        if state is not None:
            atomic(backup / 'state.json', state, 0o600)
        return backup

    def install(self):
        original = self.prepare()
        package = json.loads(original)
        if package.get('name') != 'QQ' or package.get('version', '').split('-')[0] != '3.2.34':
            raise RuntimeError('只支持 QQ 3.2.34；其他版本需要重新检查适配。')
        if package.get('main') != ORIGINAL_MAIN:
            raise RuntimeError('启动入口已有修改。请先检查或使用 --restore，不覆盖其他入口。')
        if not (self.qqdir / 'application.asar').is_file():
            raise RuntimeError('QQ 原启动文件不存在。')
        if self.state.exists() or self.state.is_symlink():
            raise RuntimeError('已有安装记录。请先 --restore，再安装新版本。')
        for name in FILES:
            path = self.qqdir / name
            if path.exists() or path.is_symlink():
                raise RuntimeError('检测到旧补丁文件，请先检查或 --restore：' + name)
        payload = {}
        for name in FILES:
            path = self.source / name
            if path.is_symlink() or not path.is_file() or not path.stat().st_size:
                raise RuntimeError('补丁源文件不存在或异常：' + name)
            payload[name] = path.read_bytes()
        backup = self.archive(original, {})
        package['main'] = PATCHED_MAIN
        patched = encoded(package)
        record = encoded({'version': package['version'], 'backup': backup.name,
                          'original_sha256': sha(original), 'patched_sha256': sha(patched),
                          'mode': stat.S_IMODE(self.package.stat().st_mode),
                          'files': {name: sha(data) for name, data in payload.items()}})
        written = []
        try:
            for name, data in payload.items():
                atomic(self.qqdir / name, data)
                written.append(name)
            self.ensure_stopped()
            # Publish the new entry only after all referenced scripts are present.
            atomic(self.package, patched, json.loads(record)['mode'])
            atomic(self.state, record, 0o600)
        except BaseException:
            if self.package.read_bytes() == patched:
                atomic(self.package, original, json.loads(record)['mode'])
            for name in written:
                path = self.qqdir / name
                if path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == sha(payload[name]):
                    path.unlink()
            if self.state.is_file() and not self.state.is_symlink() and self.state.read_bytes() == record:
                self.state.unlink()
            raise
        return backup

    def restore(self):
        current = self.prepare()
        package = json.loads(current)
        previous = None
        if self.state.exists() or self.state.is_symlink():
            state_bytes = self.read_owned(self.state)
            record = json.loads(state_bytes)
            if (set(record['files']) != set(FILES) or not record['backup'].startswith('backup-')
                    or Path(record['backup']).name != record['backup']):
                raise RuntimeError('恢复记录路径或文件集合异常。')
            backup = self.backups / record['backup']
            if self.backups.is_symlink() or backup.is_symlink():
                raise RuntimeError('备份目录异常。')
            original = self.read_owned(backup / 'package.json')
            if sha(original) != record['original_sha256']:
                raise RuntimeError('原始备份校验失败。')
            if sha(current) == record['patched_sha256'] and package.get('version') == record['version']:
                previous = original
            elif package.get('main') != ORIGINAL_MAIN:
                raise RuntimeError('入口已被其他修改覆盖，不恢复旧版 package.json。')
            files = {}
            for name in FILES:
                path = self.qqdir / name
                if path.exists() or path.is_symlink():
                    data = self.read_owned(path)
                    if sha(data) != record['files'][name]:
                        raise RuntimeError('补丁文件已另行修改，不移除：' + name)
                    files[name] = data
        else:
            # Migrate a v6.6 install cautiously, archiving its scripts instead of deleting them.
            pristine = self.qqdir / 'package.json.pristine'
            if not pristine.exists() and not pristine.is_symlink():
                raise RuntimeError('没有本补丁的安装记录或旧版 pristine 备份，无需恢复。')
            original = self.read_owned(pristine)
            baseline = json.loads(original)
            if package.get('main') == PATCHED_MAIN:
                normalized = dict(package, main=ORIGINAL_MAIN)
                if baseline != normalized or baseline.get('main') != ORIGINAL_MAIN:
                    raise RuntimeError('旧备份与当前 QQ 版本/配置不匹配，不覆盖新版文件。')
                previous = original
            elif package.get('main') != ORIGINAL_MAIN:
                raise RuntimeError('不是本补丁的启动入口，不改动。')
            files = {name: self.read_owned(self.qqdir / name) for name in FILES
                     if (self.qqdir / name).exists() or (self.qqdir / name).is_symlink()}
            files['package.json.pristine'] = original
            state_bytes = None
        backup = self.archive(current, files, state_bytes)
        mode = stat.S_IMODE(self.package.stat().st_mode)
        try:
            if previous is not None:
                atomic(self.package, previous, mode)
            for name in files:
                (self.qqdir / name).unlink()
            if state_bytes is not None:
                self.state.unlink()
        except BaseException:
            atomic(self.package, current, mode)
            for name, data in files.items():
                atomic(self.qqdir / name, data)
            if state_bytes is not None:
                atomic(self.state, state_bytes, 0o600)
            raise
        return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', action='store_true', help='安全恢复原版 QQ 入口并归档补丁')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('请用 sudo 运行；不要把 QQ 本身作为 root 启动。')
    installer = Installer('/opt/QQ/resources/app', Path(__file__).resolve().parent)
    try:
        backup = installer.restore() if args.restore else installer.install()
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print('停止：' + str(error), file=sys.stderr)
        return 1
    print('✓ 已恢复原版入口。' if args.restore else '✓ 通知补丁安装完成。')
    print('系统文件备份：' + str(backup))
    print('请以普通用户重新打开 QQ；账号和聊天记录未修改。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
