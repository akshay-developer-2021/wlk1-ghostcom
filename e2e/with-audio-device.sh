#!/usr/bin/env bash
# Run a command with a real audio device on the runner.
#
# Firefox's AudioContext never leaves "suspended" without an output device to
# open: the app's silent carrier never runs, the mesh refuses to dial, and
# every test fails at LNK 1 with "AUDIO NOT READY (ctx suspended)" and wire
# enc=0 dec=0. The firefox-audio-probe workflow measured that prefs do not
# help (autoplay is not the blocker) and neither does ALSA, and that a
# PulseAudio server with a null SINK fixes 7/7 candidates. The sink is
# VERIFIED here, not hoped for: a masked failure in this setup read as an app
# bug for a whole day.
#
# The daemon does not survive a step boundary. Measured: setup in one step
# (reporting success, sink present) and the tests in the next still failed
# with "AUDIO NOT READY (ctx none)" — so setup and the command share ONE step.
#
#   WLK1_AUDIO_DEVICE=1  install, start, verify, then run the command
#   WLK1_AUDIO_DEVICE=0  plain exec — chromium and webkit lanes need nothing
set -euo pipefail

if [ "${WLK1_AUDIO_DEVICE:-0}" = "1" ]; then
  sudo apt-get install -y --no-install-recommends pulseaudio
  # XDG_RUNTIME_DIR alone, and NOT PULSE_SERVER: exported before the daemon
  # exists, pulseaudio reads it as "use this server" and refuses to start
  # ("User-configured server at …, refusing to start/autospawn" — measured),
  # and the default socket is $XDG_RUNTIME_DIR/pulse/native anyway — which is
  # also how the browser finds the server. The dir must be private to us or
  # PulseAudio refuses to run.
  export XDG_RUNTIME_DIR=/tmp/wlk1-pa
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  pulseaudio --start --exit-idle-time=-1 --disallow-exit
  pgrep -x pulseaudio >/dev/null || { echo "PULSEAUDIO DID NOT START — the sink below cannot exist"; exit 1; }
  # 48000, the rate real desktops use and the rate WebRTC encodes at. The
  # default (44100) forces a conversion inside WebKitGTK on every outbound
  # frame — the one stage where the wire was measured to carry uninitialized
  # data instead of the source (see HANDOFF round 5).
  pactl load-module module-null-sink sink_name=wlk1_dummy rate=48000
  pactl set-default-sink wlk1_dummy
  # What this attempt actually got: a flip that happens roughly half the time
  # must not be blamed on code before these are known to be constant.
  echo "── audio env ──"
  uname -r; nproc
  dpkg-query -W -f='${Package} ${Version}\n' pulseaudio 2>/dev/null || true
  pactl info | head -3
  pactl list sinks | grep -E "Name:|Sample Rate:" | head -6
  pactl list short sinks | grep -q wlk1_dummy || { echo "NO NULL SINK — Firefox has no audio device"; exit 1; }
fi

exec "$@"
