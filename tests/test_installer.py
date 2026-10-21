import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('qq_installer', ROOT / 'install.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.qqdir = Path(self.temporary.name) / 'QQ/resources/app'
        self.qqdir.mkdir(parents=True)
        self.package = self.qqdir / 'package.json'
        self.original = module.encoded({'name': 'QQ', 'version': '3.2.34-53644',
                                       'main': module.ORIGINAL_MAIN, 'keep': {'custom': True}})
        self.package.write_bytes(self.original)
        self.package.chmod(0o640)
        (self.qqdir / 'application.asar').write_bytes(b'untouched QQ application fixture')
        self.installer = module.Installer(self.qqdir, ROOT)
        self.installer.ensure_stopped = mock.Mock()

    def legacy(self, version='3.2.34-53644'):
        (self.qqdir / 'package.json.pristine').write_bytes(self.original)
        data = dict(json.loads(self.original), main=module.PATCHED_MAIN, version=version)
        self.package.write_bytes(module.encoded(data))
        for name in module.FILES:
            (self.qqdir / name).write_bytes(('legacy ' + name).encode())

    def assert_original(self):
        self.assertEqual(self.package.read_bytes(), self.original)
        self.assertFalse(self.installer.state.exists())
        self.assertTrue(all(not (self.qqdir / name).exists() for name in module.FILES))
        self.assertEqual((self.qqdir / 'application.asar').read_bytes(), b'untouched QQ application fixture')

    def test_install_restore_roundtrip_and_only_main_changes(self):
        self.installer.install()
        current = json.loads(self.package.read_bytes())
        current['main'] = module.ORIGINAL_MAIN
        self.assertEqual(current, json.loads(self.original))
        self.assertEqual(stat.S_IMODE(self.package.stat().st_mode), 0o640)
        self.assertEqual(stat.S_IMODE(self.installer.state.stat().st_mode), 0o600)
        self.installer.restore()
        self.assert_original()

    def test_reject_unknown_version(self):
        self.package.write_bytes(module.encoded(dict(json.loads(self.original), version='3.2.35-new')))
        before = self.package.read_bytes()
        with self.assertRaises(RuntimeError): self.installer.install()
        self.assertEqual(before, self.package.read_bytes())

    def test_reject_other_entry(self):
        self.package.write_bytes(module.encoded(dict(json.loads(self.original), main='./other.js')))
        with self.assertRaises(RuntimeError): self.installer.install()

    def test_reject_existing_unmanaged_patch(self):
        p = self.qqdir / module.FILES[0]
        p.write_bytes(b'do not overwrite')
        with self.assertRaises(RuntimeError): self.installer.install()
        self.assertEqual(p.read_bytes(), b'do not overwrite')

    def test_reject_symlink_package(self):
        target = self.qqdir / 'real-package.json'
        self.package.rename(target)
        self.package.symlink_to(target.name)
        with self.assertRaises(RuntimeError): self.installer.install()
        self.assertEqual(target.read_bytes(), self.original)

    def test_reject_running_qq_before_any_write(self):
        self.installer.ensure_stopped.side_effect = RuntimeError('QQ is running')
        with self.assertRaises(RuntimeError): self.installer.install()
        self.assert_original()
        self.assertFalse(self.installer.backups.exists())

    def test_qq_restarted_during_install_rolls_back(self):
        self.installer.ensure_stopped.side_effect = [None, RuntimeError('QQ restarted')]
        with self.assertRaises(RuntimeError): self.installer.install()
        self.assert_original()

    def test_state_write_failure_rolls_back_entry_and_scripts(self):
        original_atomic = module.atomic
        def fail_state(path, *args):
            if path == self.installer.state: raise OSError('simulated state write failure')
            return original_atomic(path, *args)
        with mock.patch.object(module, 'atomic', side_effect=fail_state):
            with self.assertRaises(OSError): self.installer.install()
        self.assert_original()

    def test_restore_keeps_new_vendor_package(self):
        self.installer.install()
        updated = module.encoded(dict(json.loads(self.original), version='3.2.35-new', new_field=True))
        self.package.write_bytes(updated)
        self.installer.restore()
        self.assertEqual(self.package.read_bytes(), updated)
        self.assertFalse(self.installer.state.exists())

    def test_refuse_modified_patch_on_restore(self):
        self.installer.install()
        p = self.qqdir / module.FILES[0]
        p.write_bytes(b'other modification')
        before = self.package.read_bytes()
        with self.assertRaises(RuntimeError): self.installer.restore()
        self.assertEqual(self.package.read_bytes(), before)
        self.assertEqual(p.read_bytes(), b'other modification')

    def test_refuse_modified_entry_on_restore(self):
        self.installer.install()
        data = json.loads(self.package.read_bytes()); data['other_change'] = True
        self.package.write_bytes(module.encoded(data))
        with self.assertRaises(RuntimeError): self.installer.restore()
        self.assertTrue(self.installer.state.exists())

    def test_refuse_corrupt_original_backup(self):
        self.installer.install()
        record = json.loads(self.installer.state.read_bytes())
        (self.installer.backups / record['backup'] / 'package.json').write_bytes(b'corrupt')
        with self.assertRaises(RuntimeError): self.installer.restore()
        self.assertTrue(self.installer.state.exists())

    def test_refuse_invalid_backup_path(self):
        self.installer.install()
        record = json.loads(self.installer.state.read_bytes()); record['backup'] = '..'
        self.installer.state.write_bytes(module.encoded(record))
        with self.assertRaises(RuntimeError): self.installer.restore()

    def test_restore_legacy_install_archives_payload(self):
        self.legacy()
        backup = self.installer.restore()
        self.assert_original()
        self.assertEqual((backup / module.FILES[0]).read_bytes(), ('legacy ' + module.FILES[0]).encode())
        self.assertEqual((backup / 'package.json.pristine').read_bytes(), self.original)

    def test_refuse_stale_legacy_backup(self):
        self.legacy('3.2.35-new')
        before = self.package.read_bytes()
        with self.assertRaises(RuntimeError): self.installer.restore()
        self.assertEqual(self.package.read_bytes(), before)

    def test_legacy_restore_keeps_updated_vendor_package(self):
        self.legacy()
        new = module.encoded(dict(json.loads(self.original), version='3.2.35-new'))
        self.package.write_bytes(new)
        self.installer.restore()
        self.assertEqual(self.package.read_bytes(), new)

    def test_unknown_cli_option_is_rejected(self):
        result = subprocess.run(['bash', str(ROOT / 'install.sh'), '--invalid-option'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
