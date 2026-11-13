import contextlib
import importlib.util
import io
import json
import pathlib
import shutil
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

MODULE = pathlib.Path(__file__).resolve().parents[2] / 'service/devices.py'
spec = importlib.util.spec_from_file_location('playback_devices', MODULE)
devices = importlib.util.module_from_spec(spec) if MODULE.exists() else None
if devices:
    spec.loader.exec_module(devices)


class DevicesTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(devices, 'devices helper must exist')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.proc = self.root / 'proc'
        self.sys = self.root / 'sys'

    def card(self, index, serial='serial-one', device=0, usb=True):
        card = self.proc / 'asound' / ('card%d' % index)
        card.mkdir(parents=True, exist_ok=True)
        (card / 'id').write_text('DAC')
        (card / ('pcm%dp' % device)).mkdir()
        (card / 'pcm9c').mkdir(exist_ok=True)
        real = self.sys / 'devices' / ('usb1/1-2/1-2:1.0/sound/card%d' % index if usb else 'platform/sound/card%d' % index)
        real.mkdir(parents=True)
        link = self.sys / 'class/sound' / ('card%d' % index)
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(real)
        if usb:
            parent = real.parents[2]
            (parent / 'idVendor').write_text('1234')
            (parent / 'idProduct').write_text('abcd')
            if serial:
                (parent / 'serial').write_text(serial)
        return card

    def test_usb_identity_survives_renumber_and_disappears_cleanly(self):
        card = self.card(1)
        first = devices.enumerate_devices(self.proc, self.sys)
        self.assertEqual(len(first), 1)
        self.assertEqual(first[0]['pcm'], 'hw:CARD=DAC,DEV=0')
        self.assertTrue(first[0]['usb'])
        shutil.rmtree(card)
        self.assertEqual(devices.enumerate_devices(self.proc, self.sys), [])
        self.card(4)
        second = devices.enumerate_devices(self.proc, self.sys)
        self.assertEqual(first[0]['key'], second[0]['key'])
        self.assertEqual(second[0]['index'], 4)

    def test_usb_without_serial_uses_physical_path_and_pcm_endpoints(self):
        card = self.card(2, serial=None)
        (card / 'pcm3p').mkdir()
        result = devices.enumerate_devices(self.proc, self.sys)
        self.assertEqual([item['device'] for item in result], [0, 3])
        self.assertNotEqual(result[0]['key'], result[1]['key'])
        self.assertIn('1-2', result[0]['key'])

    def test_nonusb_uses_alsa_id(self):
        self.card(0, usb=False)
        self.assertEqual(devices.enumerate_devices(self.proc, self.sys)[0]['key'], 'alsa:DAC:0')

    def test_pi_outputs_have_friendly_labels_without_changing_pcm_identity(self):
        for index, alsa_id, driver in [(4, 'b1', 'bcm2835-audio'),
                                       (7, 'Headphones', 'bcm2835-audio'),
                                       (2, 'vc4hdmi0', 'vc4_hdmi'),
                                       (9, 'vc4hdmi1', 'vc4_hdmi')]:
            card = self.card(index, usb=False)
            (card / 'id').write_text(alsa_id)
            hardware = (self.sys / 'class/sound' / ('card%d' % index)).resolve()
            (hardware / 'device').mkdir()
            (hardware / 'device/driver').symlink_to('/sys/bus/platform/drivers/' + driver)
            if alsa_id == 'b1':
                (card / 'pcm1p').mkdir()
        (self.proc / 'asound/cards').write_text(
            ' 4 [b1             ]: bcm2835_hdmi - bcm2835 HDMI 1\n'
            '                      bcm2835 HDMI 1\n'
            ' 7 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones\n'
            ' 2 [vc4hdmi0       ]: vc4-hdmi - vc4-hdmi-0\n'
            ' 9 [vc4hdmi1       ]: vc4-hdmi - vc4-hdmi-1\n')
        result = {item['pcm']: item for item in devices.enumerate_devices(self.proc, self.sys)}
        expected = {
            'hw:CARD=b1,DEV=0': ('HDMI выход 1 (совместимый)', 'alsa:b1:0', 4, 0),
            'hw:CARD=b1,DEV=1': ('HDMI выход 2 (совместимый)', 'alsa:b1:1', 4, 1),
            'hw:CARD=Headphones,DEV=0': ('Jack 3,5 мм', 'alsa:Headphones:0', 7, 0),
            'hw:CARD=vc4hdmi0,DEV=0': ('HDMI выход 1', 'alsa:vc4hdmi0:0', 2, 0),
            'hw:CARD=vc4hdmi1,DEV=0': ('HDMI выход 2', 'alsa:vc4hdmi1:0', 9, 0),
        }
        self.assertEqual(set(result), set(expected))
        for pcm, values in expected.items():
            self.assertEqual(tuple(result[pcm][key] for key in ('label', 'key', 'index', 'device')), values)
            self.assertFalse(result[pcm]['usb'])

    def test_usb_product_name_is_preserved_and_multiple_endpoints_distinguished(self):
        card = self.card(3)
        hardware = (self.sys / 'class/sound/card3').resolve()
        (hardware.parents[2] / 'product').write_text('FiiO BTA30 PRO')
        self.assertEqual(devices.enumerate_devices(self.proc, self.sys)[0]['label'], 'FiiO BTA30 PRO')
        (card / 'pcm3p').mkdir()
        self.assertEqual([item['label'] for item in devices.enumerate_devices(self.proc, self.sys)],
                         ['FiiO BTA30 PRO (выход 1)', 'FiiO BTA30 PRO (выход 4)'])

    def test_unknown_card_id_is_preserved_without_guessing_pi_output(self):
        card = self.card(0, usb=False)
        (card / 'id').write_text('b1')
        self.assertEqual(devices.enumerate_devices(self.proc, self.sys)[0]['label'], 'b1')

    def test_invalid_cli_arguments_return_bounded_json(self):
        for argv in [['check', 'hw:0;touch /tmp/oops', '44100', '24', '2'], ['check', 'default', '44100', '24', '2'], ['discover', '../1'], ['check', 'hw:CARD=DAC,DEV=0', '0', '24', '2'], ['unknown'], ['check']]:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = devices.main(argv)
            self.assertNotEqual(code, 0)
            self.assertIn('error', json.loads(output.getvalue()))
            self.assertLess(len(output.getvalue()), 1024)

    def test_probe_checks_joint_exact_parameters_without_committing(self):
        library = FakeAlsa()
        self.assertEqual(devices.check_pcm('hw:CARD=DAC,DEV=0', 44100, 24, 2, library=library), {'supported': True})
        self.assertEqual(library.open_mode, 1)
        self.assertEqual(library.accepted, ('S32_LE', 44100, 2))
        self.assertTrue(library.closed)
        self.assertTrue(library.freed)

    def test_only_lossless_integer_formats_are_considered(self):
        for bits in (16, 32):
            library = FakeAlsa()
            self.assertEqual(devices.check_pcm('hw:CARD=DAC,DEV=0', 96000, bits, 2, library=library), {'supported': True})
            self.assertEqual(library.accepted, ('S32_LE', 96000, 2))
            if bits == 32:
                self.assertEqual(list(library.formats.values()), ['S32_LE'])

    def test_busy_and_unsupported_are_errors(self):
        for library in [FakeAlsa(busy=True), FakeAlsa(unsupported=True)]:
            with self.assertRaises(devices.HelperError):
                devices.check_pcm('hw:CARD=DAC,DEV=0', 44100, 24, 2, library=library)
            self.assertEqual(library.closed, not library.busy)
            self.assertEqual(library.freed, not library.busy)

    def test_discovery_only_uses_owned_listener_and_local_endpoints(self):
        class Handler(BaseHTTPRequestHandler):
            endpoint = '/AVTransport/control.xml'
            def do_GET(self):
                body = ('<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>%s</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/RenderingControl/control.xml</controlURL></service></serviceList></device></root>' % self.endpoint).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        process = self.proc / '42'
        (process / 'fd').mkdir(parents=True)
        (process / 'net').mkdir()
        (process / 'comm').write_text('ap2renderer\n')
        (process / 'fd/3').symlink_to('socket:[12345]')
        (process / 'fd/4').symlink_to('socket:[12346]')
        port = server.server_port
        (process / 'net/tcp').write_text('header\n 0: 00000000:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345\n' % port + ' 1: 00000000:1E63 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12346\n')
        result = devices.discover(42, self.proc)
        self.assertEqual(result['apiUrl'], 'http://127.0.0.1:7779/')
        self.assertEqual(result['controlUrl'], 'http://127.0.0.1:%d/AVTransport/control.xml' % port)
        self.assertEqual(result['renderingControlUrl'], 'http://127.0.0.1:%d/RenderingControl/control.xml' % port)
        (process / 'fd/4').unlink()
        with self.assertRaises(devices.HelperError):
            devices.discover(42, self.proc)
        (process / 'fd/4').symlink_to('socket:[12346]')
        Handler.endpoint = 'http://example.org/control'
        with self.assertRaises(devices.HelperError):
            devices.discover(42, self.proc)
        Handler.endpoint = '/AVTransport/control.xml'
        (process / 'fd/3').unlink()
        with self.assertRaises(devices.HelperError):
            devices.discover(42, self.proc)
        (process / 'comm').write_text('other-process')
        with self.assertRaises(devices.HelperError):
            devices.discover(42, self.proc)


class FakeAlsa:
    def __init__(self, busy=False, unsupported=False):
        self.busy, self.unsupported = busy, unsupported
        self.closed = self.freed = False
        self.formats = {}
    def snd_pcm_open(self, pointer, name, stream, mode):
        self.open_mode = mode
        return -16 if self.busy else 0
    def snd_pcm_close(self, pointer):
        self.closed = True
    def snd_pcm_hw_params_malloc(self, pointer):
        return 0
    def snd_pcm_hw_params_free(self, pointer):
        self.freed = True
    def snd_pcm_hw_params_any(self, pcm, params):
        return 0
    def snd_pcm_format_value(self, name):
        self.formats[len(self.formats)] = name.decode()
        return len(self.formats) - 1
    def snd_pcm_hw_params_set_access(self, *args):
        return 0
    def snd_pcm_hw_params_set_format(self, pcm, params, value):
        self.format = self.formats[value]
        return 0 if self.format == 'S32_LE' else -22
    def snd_pcm_hw_params_set_channels(self, pcm, params, channels):
        self.channels = channels
        return 0
    def snd_pcm_hw_params_set_rate(self, pcm, params, rate, direction):
        self.accepted = self.format, rate, self.channels
        return -22 if self.unsupported else 0


if __name__ == '__main__':
    unittest.main()
