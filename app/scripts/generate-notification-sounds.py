"""Generates the notification sounds shipped inside the app.

They are synthesised rather than downloaded for two reasons. The sounds every
phone ships with are copyrighted, and an app that puts them in its own bundle
is redistributing them; and a generated tone is a few kilobytes of plain
arithmetic anyone can read and rebuild, which is the same standard the rest of
this project holds itself to.

Format is dictated by iOS: a notification sound must be linear PCM (or a small
set of compressed alternatives) in a .wav, .caf or .aiff container and last no
more than 30 seconds. These are under a second and a half.

Run from the app directory:  python scripts/generate-notification-sounds.py
"""

import math
import os
import struct
import wave

RATE = 44100
OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'sounds')

# Each sound is a set of (frequency in Hz, relative loudness, start time in
# seconds, decay constant). A partial fades as exp(-t / decay), which is how a
# struck object actually loses energy -- a tone cut off flat instead clicks.
SOUNDS = {
    # A struck bell: a fundamental with its octave and a twelfth above it,
    # each quieter and shorter-lived than the last.
    'sino': (1.20, [(880.0, 1.00, 0.0, 0.38), (1760.0, 0.42, 0.0, 0.22), (2640.0, 0.16, 0.0, 0.13)]),
    # One short, bright note. The plainest of them.
    'toque': (0.30, [(1046.5, 1.00, 0.0, 0.075), (2093.0, 0.22, 0.0, 0.045)]),
    # Two notes a third apart, the second just late enough to be heard as
    # separate rather than as a chord.
    'duplo': (0.55, [(987.8, 0.90, 0.0, 0.060), (1318.5, 0.90, 0.135, 0.070)]),
    # Low and soft, for wanting to be told without being startled.
    'grave': (1.30, [(329.6, 1.00, 0.0, 0.45), (493.9, 0.35, 0.0, 0.30)]),
}

ATTACK = 0.004   # seconds of fade-in, so the sound starts rather than cracks
RELEASE = 0.030  # seconds of fade-out at the very end, for the same reason
PEAK = 0.72      # headroom: notification sounds that clip sound cheap


def render(duration, partials):
    frames = int(RATE * duration)
    samples = [0.0] * frames
    for freq, level, start, decay in partials:
        begin = int(start * RATE)
        for i in range(begin, frames):
            t = (i - begin) / RATE
            samples[i] += level * math.exp(-t / decay) * math.sin(2 * math.pi * freq * t)

    peak = max(abs(s) for s in samples) or 1.0
    attack_frames = max(1, int(ATTACK * RATE))
    release_frames = max(1, int(RELEASE * RATE))
    out = bytearray()
    for i, sample in enumerate(samples):
        value = sample / peak * PEAK
        if i < attack_frames:
            value *= i / attack_frames
        remaining = frames - i
        if remaining < release_frames:
            value *= remaining / release_frames
        out += struct.pack('<h', int(max(-1.0, min(1.0, value)) * 32767))
    return bytes(out)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (duration, partials) in SOUNDS.items():
        path = os.path.join(OUT, f'{name}.wav')
        with wave.open(path, 'wb') as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes(render(duration, partials))
        print(f'{name}.wav  {os.path.getsize(path) / 1024:.0f} KB  {duration:.2f}s')


if __name__ == '__main__':
    main()
