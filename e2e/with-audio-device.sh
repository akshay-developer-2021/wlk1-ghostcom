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
  # The browser is a PulseAudio CLIENT: it must find that server, and the
  # socket dir must be private to us or PulseAudio refuses to start.
  export XDG_RUNTIME_DIR=/tmp/wlk1-pa
  export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  pulseaudio --start --exit-idle-time=-1 --disallow-exit
  pactl load-module module-null-sink sink_name=wlk1_dummy
  pactl set-default-sink wlk1_dummy
  pactl info | head -3
  pactl list short sinks | grep -q wlk1_dummy || { echo "NO NULL SINK — Firefox has no audio device"; exit 1; }
fi

exec "$@"
