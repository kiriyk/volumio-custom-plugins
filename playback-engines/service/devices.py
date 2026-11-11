#!/usr/bin/env python3
"""Read-only ALSA capability and owned Album Player endpoint discovery.

Capability checks constrain a temporary hw_params object; they never apply it
or send samples. A successful check is capability evidence, not bit-perfect proof.
"""
import ctypes
import ctypes.util
import http.client
import json
import pathlib
import re
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET


class HelperError(Exception):
    pass


PCM = re.compile(r'hw:CARD=([A-Za-z0-9_-]{1,64}),DEV=([0-9]{1,3})\Z')


def _read(path):
    return path.read_text()[:4096].strip()


def enumerate_devices(proc_root='/proc', sys_root='/sys'):
    proc, sysfs = pathlib.Path(proc_root), pathlib.Path(sys_root)
    result = []
    cards = proc / 'asound'
    if not cards.exists():
        return result
    for card in sorted(cards.glob('card[0-9]*')):
        match = re.fullmatch(r'card([0-9]+)', card.name)
        if not match:
            continue
        try:
            alsa_id = _read(card / 'id')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', alsa_id):
                continue
            hardware = (sysfs / 'class/sound' / card.name).resolve(strict=True)
            usb_device = next((p for p in (hardware, *hardware.parents)
                               if (p / 'idVendor').is_file() and (p / 'idProduct').is_file()), None)
            usb = usb_device is not None
            if usb:
                vendor, product = _read(usb_device / 'idVendor'), _read(usb_device / 'idProduct')
                serial = _read(usb_device / 'serial') if (usb_device / 'serial').is_file() else ''
                identity = 'serial:' + urllib.parse.quote(serial, safe='') if serial else 'path:' + usb_device.name
                key = 'usb:%s:%s:%s' % (vendor, product, identity)
                label = _read(usb_device / 'product') if (usb_device / 'product').is_file() else alsa_id
            else:
                key, label = 'alsa:' + alsa_id, alsa_id
            for pcm in sorted(card.glob('pcm*p')):
                endpoint = re.fullmatch(r'pcm([0-9]+)p', pcm.name)
                if not endpoint or not pcm.is_dir():
                    continue
                device = int(endpoint.group(1))
                result.append({'key': '%s:%d' % (key, device), 'label': '%s (device %d)' % (label, device),
                               'pcm': 'hw:CARD=%s,DEV=%d' % (alsa_id, device),
                               'index': int(match.group(1)), 'device': device, 'usb': usb})
        except OSError:
            # A removed USB card must not poison discovery of other hardware.
            continue
    return result


def _alsa_library():
    lib = ctypes.CDLL(ctypes.util.find_library('asound') or 'libasound.so.2')
    pointer = ctypes.c_void_p
    signatures = {
        'snd_pcm_open': ([ctypes.POINTER(pointer), ctypes.c_char_p, ctypes.c_int, ctypes.c_int], ctypes.c_int),
        'snd_pcm_close': ([pointer], ctypes.c_int),
        'snd_pcm_hw_params_malloc': ([ctypes.POINTER(pointer)], ctypes.c_int),
        'snd_pcm_hw_params_free': ([pointer], None),
        'snd_pcm_hw_params_any': ([pointer, pointer], ctypes.c_int),
        'snd_pcm_hw_params_set_access': ([pointer, pointer, ctypes.c_int], ctypes.c_int),
        'snd_pcm_format_value': ([ctypes.c_char_p], ctypes.c_int),
        'snd_pcm_hw_params_set_format': ([pointer, pointer, ctypes.c_int], ctypes.c_int),
        'snd_pcm_hw_params_set_channels': ([pointer, pointer, ctypes.c_uint], ctypes.c_int),
        'snd_pcm_hw_params_set_rate': ([pointer, pointer, ctypes.c_uint, ctypes.c_int], ctypes.c_int),
    }
    for name, (arguments, result) in signatures.items():
        function = getattr(lib, name)
        function.argtypes, function.restype = arguments, result
    return lib


def check_pcm(pcm, rate, bits, channels, library=None):
    if not isinstance(pcm, str) or not PCM.fullmatch(pcm):
        raise HelperError('Only a stable hardware PCM is allowed')
    if type(rate) is not int or not 8000 <= rate <= 1536000 or bits not in (16, 24, 32) or type(channels) is not int or not 1 <= channels <= 32:
        raise HelperError('Unsupported PCM rate, precision or channel count')
    lib = library if library is not None else _alsa_library()
    handle, params = ctypes.c_void_p(), ctypes.c_void_p()
    opened = allocated = False
    try:
        status = lib.snd_pcm_open(ctypes.byref(handle), pcm.encode('ascii'), 0, 1)
        if status < 0:
            raise HelperError('PCM busy' if status == -16 else 'Cannot open PCM (%d)' % status)
        opened = True
        if lib.snd_pcm_hw_params_malloc(ctypes.byref(params)) < 0:
            raise HelperError('Cannot allocate PCM parameters')
        allocated = True
        formats = {16: ('S16_LE', 'S24_3LE', 'S24_LE', 'S32_LE'),
                   24: ('S24_3LE', 'S24_LE', 'S32_LE'), 32: ('S32_LE',)}[bits]
        for name in formats:
            if lib.snd_pcm_hw_params_any(handle, params) < 0:
                continue
            value = lib.snd_pcm_format_value(name.encode('ascii'))
            if value < 0:
                continue
            # RW_INTERLEAVED; exact setters constrain one shared params object.
            if lib.snd_pcm_hw_params_set_access(handle, params, 3) < 0:
                continue
            if lib.snd_pcm_hw_params_set_format(handle, params, value) < 0:
                continue
            if lib.snd_pcm_hw_params_set_channels(handle, params, channels) < 0:
                continue
            if lib.snd_pcm_hw_params_set_rate(handle, params, rate, 0) < 0:
                continue
            return {'supported': True}
        raise HelperError('Hardware does not support exact PCM parameters')
    finally:
        if allocated:
            lib.snd_pcm_hw_params_free(params)
        if opened:
            lib.snd_pcm_close(handle)


def _owned_ports(process):
    inodes = set()
    for fd in (process / 'fd').iterdir():
        try:
            match = re.fullmatch(r'socket:\[([0-9]+)\]', str(fd.readlink()))
            if match:
                inodes.add(match.group(1))
        except OSError:
            continue
    ports = set()
    for table in ('tcp', 'tcp6'):
        try:
            lines = (process / 'net' / table).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) > 9 and fields[3] == '0A' and fields[9] in inodes:
                host, port = fields[1].split(':')
                # We only connect via IPv4 loopback; skip remote-bound listeners.
                if host in ('00000000', '0100007F', '00000000000000000000000000000000'):
                    ports.add(int(port, 16))
    return ports


def _local_url(base, value, ports):
    url = urllib.parse.urljoin(base, value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password or parsed.fragment or parsed.port not in ports:
        raise HelperError('Renderer returned an unowned or non-local endpoint')
    return url


def discover(pid, proc_root='/proc', http_timeout=0.4):
    if not re.fullmatch(r'[1-9][0-9]{0,9}', str(pid)):
        raise HelperError('Invalid renderer PID')
    process = pathlib.Path(proc_root) / str(pid)
    try:
        if _read(process / 'comm') != 'ap2renderer':
            raise HelperError('PID is not ap2renderer')
        ports = _owned_ports(process)
        if 7779 not in ports:
            raise HelperError('Owned renderer API is not ready')
        deadline = time.monotonic() + 4
        for port in sorted(ports - {7779})[:16]:
            for path in ('/description.xml', '/', '/DeviceDescription.xml', '/rootDesc.xml'):
                if time.monotonic() >= deadline:
                    raise HelperError('Renderer discovery not ready')
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=min(http_timeout, max(.01, deadline - time.monotonic())))
                try:
                    connection.request('GET', path)
                    response = connection.getresponse()
                    if response.status != 200:
                        continue
                    body = response.read(262145)
                    if len(body) > 262144 or b'<!DOCTYPE' in body.upper():
                        continue
                    root = ET.fromstring(body)
                    base = 'http://127.0.0.1:%d%s' % (port, path)
                    url_base = root.findtext('{*}URLBase')
                    if url_base:
                        base = _local_url(base, url_base, ports)
                    endpoints = {}
                    for service in root.findall('.//{*}service'):
                        service_type = service.findtext('{*}serviceType', '')
                        target = {'AVTransport': 'controlUrl', 'RenderingControl': 'renderingControlUrl'}
                        parts = service_type.split(':')
                        if len(parts) >= 2 and parts[-2] in target:
                            endpoint = service.findtext('{*}controlURL', '').strip()
                            if endpoint:
                                endpoints[target[parts[-2]]] = _local_url(base, endpoint, ports)
                    if 'controlUrl' in endpoints and 'renderingControlUrl' in endpoints:
                        # Recheck ownership after network IO; caller retries startup races.
                        if _read(process / 'comm') != 'ap2renderer' or not ports.issubset(_owned_ports(process)):
                            raise HelperError('Renderer ownership changed')
                        endpoints['apiUrl'] = 'http://127.0.0.1:7779/'
                        return endpoints
                except (OSError, http.client.HTTPException, ET.ParseError, ValueError):
                    continue
                finally:
                    connection.close()
    except OSError:
        raise HelperError('Renderer process is unavailable') from None
    raise HelperError('Owned renderer endpoints are not ready')


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args == ['devices']:
            result = enumerate_devices()
        elif len(args) == 5 and args[0] == 'check':
            if not all(re.fullmatch(r'[0-9]{1,7}', value) for value in args[2:]):
                raise HelperError('Invalid PCM parameters')
            result = check_pcm(args[1], *map(int, args[2:]))
        elif len(args) == 2 and args[0] == 'discover':
            result = discover(args[1])
        else:
            raise HelperError('Usage: devices | check PCM RATE BITS CHANNELS | discover PID')
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (HelperError, OSError, ValueError) as error:
        message = str(error).replace('\n', ' ')[:320]
        print(json.dumps({'error': message}, ensure_ascii=True))
        return 1


if __name__ == '__main__':
    sys.exit(main())
