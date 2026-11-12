#!/usr/bin/env python3
"""Native FFmpeg proof: CENC HEVC/AAC progressive MP4 -> clear fMP4.

Only locally generated media and a synthetic key. This tests whether libavformat
can emit an actual fragment before source EOF; not browser WASM or real Hongguo.
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import time
from pathlib import Path

KEY = '00112233445566778899aabbccddeeff'
KID = '11223344556677889900aabbccddeeff'


def run(*args: str) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def probe() -> None:
    with tempfile.TemporaryDirectory(prefix='cenc-remux-') as directory:
        source = Path(directory) / 'encrypted-progressive.mp4'
        target = Path(directory) / 'clear-fragmented.mp4'
        run('ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-threads', '1', '-f', 'lavfi',
            '-i', 'testsrc=size=320x180:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '5', '-c:v', 'libx265', '-preset', 'ultrafast',
            '-x265-params',
            'pools=none:frame-threads=1:wpp=0:log-level=error:keyint=24:min-keyint=24:scenecut=0',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
            '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', KEY,
            '-encryption_kid', KID, '-movflags', '+faststart', '-y', str(source))
        original = source.read_bytes()
        assert b'moov' in original and b'mdat' in original and b'mvex' not in original
        assert b'senc' in original and b'tenc' in original

        command = ['ffmpeg', '-nostdin', '-loglevel', 'error',
                   '-decryption_key', KEY, '-i', 'pipe:0',
                   '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
                   '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                   '-flush_packets', '1', '-f', 'mp4', 'pipe:1']
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0)
        assert process.stdin and process.stdout and process.stderr

        state = {'sent': 0, 'closed': False, 'first_fragment': None,
                 'writer_error': None}
        output = bytearray()

        def send_source() -> None:
            try:
                for offset in range(0, len(original), 2048):
                    part = original[offset:offset + 2048]
                    process.stdin.write(part)
                    state['sent'] = offset + len(part)
                    time.sleep(.015)
            except Exception as error:
                state['writer_error'] = str(error)
            finally:
                process.stdin.close()
                state['closed'] = True

        def receive_fragments() -> None:
            while True:
                part = process.stdout.read(4096)
                if not part:
                    break
                overlap = bytes(output[-16:])
                output.extend(part)
                if state['first_fragment'] is None and b'moof' in overlap + part:
                    state['first_fragment'] = (state['sent'], state['closed'])

        sender = threading.Thread(target=send_source)
        receiver = threading.Thread(target=receive_fragments)
        sender.start()
        receiver.start()
        sender.join(timeout=20)
        receiver.join(timeout=20)
        assert not sender.is_alive() and not receiver.is_alive(), 'FFmpeg stream deadlock'
        result = process.wait(timeout=10)
        assert result == 0, process.stderr.read().decode()[-500:]
        assert state['writer_error'] is None, state['writer_error']
        assert state['first_fragment'] is not None, 'No fMP4 fragment output'
        first_input_bytes, source_eof = state['first_fragment']
        assert not source_eof and first_input_bytes < len(original), (
            'First fragment arrived only after reading the entire source')
        assert b'mvex' in output and b'moof' in output and b'mdat' in output
        assert b'senc' not in output and b'tenc' not in output
        target.write_bytes(output)

        metadata = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_name', '-of', 'json', str(target)]))
        codecs = {stream['codec_name'] for stream in metadata['streams']}
        assert {'hevc', 'aac'} <= codecs, codecs
        run('ffmpeg', '-nostdin', '-v', 'error', '-i', str(target),
            '-f', 'null', '-')
        print(json.dumps({
            'result': 'PASS',
            'source': 'synthetic HEVC/AAC progressive CENC MP4',
            'target': 'clear HEVC/AAC fMP4',
            'inputBytes': len(original),
            'firstFragmentInputBytes': first_input_bytes,
            'inputEofAtFirstFragment': source_eof,
            'firstFragmentInputPercent': round(
                100 * first_input_bytes / len(original), 1),
            'moofCount': output.count(b'moof'),
            'codecs': sorted(codecs),
        }))


if __name__ == '__main__':
    probe()
