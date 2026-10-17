/**
 * Why does Firefox never link in CI?
 *
 * Measured, not guessed. The suite's Firefox lane fails every test at
 * "LNK 1" with the mesh reporting AUDIO NOT READY (ctx suspended) forever:
 * the shared silent-carrier AudioContext never reaches "running", so the
 * mesh refuses to dial at all. Autoplay prefs did not fix it, which points
 * at the audio BACKEND (cubeb) having no device to open on a headless
 * runner — a different problem with a different fix.
 *
 * This probe launches headless Firefox once per candidate configuration and
 * prints what the AudioContext does, so the next change is chosen from
 * evidence. Candidate 5+ point the backend at a null PCM (ALSA_CONFIG_PATH)
 * and at a forced ALSA cubeb backend — the two software-only devices a
 * runner can offer without hardware. The workflow around this script also
 * brings up a PulseAudio null sink and tries `snd-dummy`, then re-runs this
 * same list so the log shows every option side by side.
 *
 * Run: node e2e/probe-firefox-audio.mjs
 */
import { writeFileSync } from 'node:fs';
import { firefox } from 'playwright';

const AUTOPLAY = {
  'media.autoplay.block-webaudio': false,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
};

/* ALSA's equivalent of a "black hole" device: opens fine, consumes writes,
   produces nothing. Honoured through the ALSA_CONFIG_PATH environment
   variable, which alsa-lib reads instead of /etc/asound.conf. */
const ALSA_NULL_CONF = '/tmp/wlk1-asound-null.conf';
writeFileSync(ALSA_NULL_CONF, 'pcm.!default { type null }\nctl.!default { type null }\n');

/** Each candidate: a name, prefs, and any change to the environment. */
const CANDIDATES = [
  { name: 'stock firefox', prefs: {} },
  { name: 'autoplay prefs', prefs: AUTOPLAY },
  { name: 'autoplay + cubeb sandbox off', prefs: { ...AUTOPLAY, 'media.cubeb.sandbox': false } },
  { name: 'autoplay + fake stream pref', prefs: { ...AUTOPLAY, 'media.navigator.streams.fake': true } },
  { name: 'autoplay + ALSA null default PCM', prefs: AUTOPLAY, env: { ALSA_CONFIG_PATH: ALSA_NULL_CONF } },
  {
    name: 'ALSA null PCM + cubeb forced to alsa',
    prefs: { ...AUTOPLAY, 'media.cubeb.backend': 'alsa' },
    env: { ALSA_CONFIG_PATH: ALSA_NULL_CONF },
  },
  {
    name: 'ALSA null PCM + cubeb sandbox off',
    prefs: { ...AUTOPLAY, 'media.cubeb.sandbox': false },
    env: { ALSA_CONFIG_PATH: ALSA_NULL_CONF },
  },
];

/** Hard bound per candidate: a browser that never answers must not hold a
    CI runner. This exact hang is why an earlier version of this probe sat
    in "in progress" for 28 minutes — Firefox refuses a top-level data: URI
    navigation, so goto() never settled, and a bare Promise.race left the
    browser process alive so node never exited. */
const CANDIDATE_TIMEOUT_MS = 45_000;

let current = null;   // the browser being probed, so a timeout can kill it

async function probe(prefs, env) {
  current = await firefox.launch({
    headless: true,
    firefoxUserPrefs: prefs,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  try {
    const page = await current.newPage();
    await page.goto('about:blank');
    return await page.evaluate(async () => {
      const ctx = new AudioContext();
      const before = ctx.state;
      let resumeError = null;
      try {
        await ctx.resume();
      } catch (err) {
        resumeError = String(err);
      }
      /* The app's actual use: an oscillator into a MediaStreamDestination.
         A context can report "running" while still producing no samples if
         its output backend never started, so count real frames. */
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const analyser = ctx.createAnalyser();
      osc.connect(analyser);
      analyser.connect(dest);
      osc.start();
      await new Promise((r) => setTimeout(r, 600));
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const track = dest.stream.getAudioTracks()[0];
      return {
        before,
        after: ctx.state,
        resumeError,
        sampleRate: ctx.sampleRate,
        oscillatorPeak: Number(peak.toFixed(4)),
        track: track ? { readyState: track.readyState, enabled: track.enabled, muted: track.muted } : null,
      };
    });
  } finally {
    const b = current;
    current = null;
    await b.close().catch(() => {});
  }
}

async function bounded(c) {
  let timer;
  try {
    return await Promise.race([
      probe(c.prefs, c.env),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          /* Closing the browser makes the hung evaluate reject, so the
             orphaned probe settles and node can exit. */
          try { await current?.close(); } catch { /* already gone */ }
          reject(new Error(`no answer in ${CANDIDATE_TIMEOUT_MS / 1000}s`));
        }, CANDIDATE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const c of CANDIDATES) {
  try {
    const r = await bounded(c);
    const works = r.after === 'running' && r.oscillatorPeak > 0;
    console.log(`${works ? 'WORKS ' : 'BROKEN'} ${c.name}: ${JSON.stringify(r)}`);
  } catch (err) {
    console.log(`BROKEN ${c.name}: launch/eval failed — ${err.message.split('\n')[0]}`);
  }
}
