import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

MODULE = pathlib.Path(__file__).resolve().parents[2] / 'scripts/install_renderer.py'
spec = importlib.util.spec_from_file_location('install_renderer', MODULE)
installer = importlib.util.module_from_spec(spec) if MODULE.exists() else None
if installer:
    spec.loader.exec_module(installer)


class InstallRendererTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(installer, 'renderer installer must exist')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.state = self.root / 'state'
        self.binary = b'\x7fELF\x01\x01' + bytes(12) + b'\x28\x00' + bytes(32)

    def archive(self, additions=()):
        archive = self.root / 'renderer.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            for name, data in [('aprenderer/ap2renderer', self.binary), ('aprenderer/config.dat', b'factory'), ('aprenderer/renderer.html', b'html')]:
                item = tarfile.TarInfo(name)
                item.size = len(data)
                output.addfile(item, io.BytesIO(data))
            for item in additions:
                output.addfile(item, io.BytesIO(b'x' * item.size) if item.isfile() else None)
        return archive, hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_install_preserves_existing_profiles_and_renderer_configuration(self):
        self.state.mkdir()
        (self.state / 'settings.json').write_bytes(b'profiles-and-accounts')
        (self.state / 'renderer').mkdir()
        (self.state / 'renderer/config.dat').write_bytes(b'personal')
        archive, digest = self.archive()
        installer.install_archive(archive, self.state, expected_sha256=digest)
        self.assertEqual((self.state / 'renderer/config.dat').read_bytes(), b'personal')
        self.assertEqual((self.state / 'settings.json').read_bytes(), b'profiles-and-accounts')
        self.assertEqual((self.state / 'renderer/ap2renderer').read_bytes(), self.binary)
        self.assertEqual((self.state / 'renderer/ap2renderer').stat().st_mode & 0o777, 0o755)

    def test_first_install_keeps_factory_config_private(self):
        archive, digest = self.archive()
        installer.install_archive(archive, self.state, expected_sha256=digest)
        self.assertEqual((self.state / 'renderer/config.dat').read_bytes(), b'factory')
        self.assertEqual((self.state / 'renderer/config.dat').stat().st_mode & 0o777, 0o600)

    def test_checksum_failure_never_installs_binary(self):
        archive, _ = self.archive()
        with self.assertRaises(installer.InstallError):
            installer.install_archive(archive, self.state, expected_sha256='0' * 64)
        self.assertFalse((self.state / 'renderer/ap2renderer').exists())

    def test_rejects_traversal_links_devices_and_duplicate_paths_before_writes(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/tmp/escape', tarfile.REGTYPE), ('aprenderer/../escape', tarfile.REGTYPE), ('aprenderer/link', tarfile.SYMTYPE), ('aprenderer/link', tarfile.LNKTYPE), ('aprenderer/device', tarfile.CHRTYPE), ('aprenderer/ap2renderer', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind):
                item = tarfile.TarInfo(name)
                item.type, item.linkname = kind, '/tmp/escape'
                archive, digest = self.archive([item])
                with self.assertRaises(installer.InstallError):
                    installer.install_archive(archive, self.state, expected_sha256=digest)
                self.assertFalse((self.state / 'renderer/ap2renderer').exists())

    def test_rejects_oversize_archive_before_writes(self):
        archive, digest = self.archive()
        with self.assertRaises(installer.InstallError):
            installer.install_archive(archive, self.state, expected_sha256=digest, max_bytes=32)
        self.assertFalse((self.state / 'renderer/ap2renderer').exists())

    def test_existing_symlink_cannot_escape_state_directory(self):
        (self.state / 'renderer').mkdir(parents=True)
        outside = self.root / 'outside'
        outside.write_bytes(b'do not touch')
        (self.state / 'renderer/config.dat').symlink_to(outside)
        archive, digest = self.archive()
        with self.assertRaises(installer.InstallError):
            installer.install_archive(archive, self.state, expected_sha256=digest)
        self.assertEqual(outside.read_bytes(), b'do not touch')


if __name__ == '__main__':
    unittest.main()
