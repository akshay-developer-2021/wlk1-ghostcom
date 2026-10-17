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
 * evidence. Run: node e2e/probe-firefox-audio.mjs
 */
import { firefox } from 'playwright';

const AUTOPLAY = {
  'media.autoplay.block-webaudio': false,
  'media.autoplay.default': 0,
  'media.autoplay.blocking_policy': 0,
};

/** Each candidate: a name, prefs, and any change to the environment. */
const CANDIDATES = [
  { name: 'stock firefox', prefs: {} },
  { name: 'autoplay prefs', prefs: AUTOPLAY },
  { name: 'autoplay + cubeb sandbox off', prefs: { ...AUTOPLAY, 'media.cubeb.sandbox': false } },
  { name: 'autoplay + fake stream pref', prefs: { ...AUTOPLAY, 'media.navigator.streams.fake': true } },
];

/** Hard bound per candidate: a browser that never answers must not hold a
    CI runner for half an hour. This exact hang is why the first version of
    this probe sat in "in progress" for 28 minutes — Firefox refuses a
    top-level data: URI navigation, so goto() never settled. */
const CANDIDATE_TIMEOUT_MS = 45_000;

async function probe(prefs) {
  const browser = await firefox.launch({ headless: true, firefoxUserPrefs: prefs });
  try {
    const page = await browser.newPage();
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
    await browser.close();
  }
}

async function bounded(prefs) {
  return Promise.race([
    probe(prefs),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no answer in ${CANDIDATE_TIMEOUT_MS / 1000}s`)), CANDIDATE_TIMEOUT_MS).unref?.(),
    ),
  ]);
}

for (const c of CANDIDATES) {
  try {
    const r = await bounded(c.prefs);
    const works = r.after === 'running' && r.oscillatorPeak > 0;
    console.log(`${works ? 'WORKS ' : 'BROKEN'} ${c.name}: ${JSON.stringify(r)}`);
  } catch (err) {
    console.log(`BROKEN ${c.name}: launch/eval failed — ${err.message.split('\n')[0]}`);
  }
}