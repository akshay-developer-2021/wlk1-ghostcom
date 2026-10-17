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
  # Fragment size drives how often the server wakes: 10ms x 4 is a finer,
  # more predictable callback cadence than the distro's 25ms default, without
  # asking for a latency a timer-driven sink cannot deliver.
  mkdir -p "$HOME/.config/pulse"
  cat > "$HOME/.config/pulse/daemon.conf" <<'CONF'
default-sample-rate = 48000
default-fragment-size-msec = 10
default-fragments = 4
CONF
  pulseaudio --start --exit-idle-time=-1 --disallow-exit
  pgrep -x pulseaudio >/dev/null || { echo "PULSEAUDIO DID NOT START — the sink below cannot exist"; exit 1; }
  # A REAL device (kernel ALSA loopback: hardware-timed) beats the timer-paced
  # null sink. The null sink is the one place WebKitGTK's outbound JS-audio
  # was measured handing the encoder uninitialized data instead of the source
  # (HANDOFF round 5). Fall back to the null sink when the module is missing.
  sudo chmod -R a+rw /dev/snd 2>/dev/null || true
  if sudo modprobe snd-aloop >/dev/null 2>&1 \
     && pactl load-module module-alsa-sink sink_name=wlk1_dummy device=hw:Loopback,0,0 >/dev/null 2>&1; then
    echo "AUDIO PATH: snd-aloop hw:Loopback,0,0 (hardware-timed)"
  else
    pactl load-module module-null-sink sink_name=wlk1_dummy rate=48000
    echo "AUDIO PATH: null sink (timer) — snd-aloop unavailable"
  fi
  pactl set-default-sink wlk1_dummy
  # What this attempt actually got: a flip that happens roughly half the time
  # must not be blamed on code before these are known to be constant.
  echo "── audio env ──"
  uname -r; nproc
  dpkg-query -W -f='${Package} ${Version}\n' pulseaudio 2>/dev/null || true
  pactl info | head -2
  pactl list sinks > /tmp/wlk1-sinks.txt 2>/dev/null || true
  head -22 /tmp/wlk1-sinks.txt
  pactl list short sinks | grep -q wlk1_dummy || { echo "NO NULL SINK — Firefox has no audio device"; exit 1; }
fi

exec "$@"
