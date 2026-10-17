/**
 * Audio utilities for e2e testing: tone generation, injection, recording,
 * analysis and verification.
 *
 * All page-side work runs as real functions (not serialized strings) so the
 * browser code stays type-checked and Playwright awaits the returned promise.
 */

import type { Page } from '@playwright/test';

export interface AudioAnalysis {
  freq: number;      // dominant frequency in Hz (zero-crossing estimate)
  duration: number;  // active-region duration in ms
  rms: number;       // root-mean-square amplitude (0-1)
  /* Reported, not asserted: `freq` alone decides. A starved audio thread drops
     samples between crossings, which reads LOW (a clean 1000Hz tone measured
     941Hz on a device-less WebKit sender), while an ear hears the pitch in
     what did arrive. medianFreq is that pitch; glitches counts the crossing
     intervals far off it, so a red run says which of the two happened. */
  medianFreq: number;
  glitches: number;
  passed: boolean;
}

/** Inject a pure sine tone as a MediaStreamTrack the mesh can transmit. */
export async function injectTxTrack(page: Page, freq: number, durationMs: number): Promise<void> {
  await page.evaluate(async ({ freq: f, durationMs: ms }) => {
    /* The DEVICE's rate, never a forced 48000: a mic track carries the device
       rate in production, and the sender's resampler is not what is on trial
       here. */
    const ctx = new AudioContext();
    /* A generator that is not RUNNING sends nothing, and an engine asked to
       encode a track that produces no frames hands its encoder whatever is in
       the buffer: the recording was loud broadband noise — 50% of its energy
       above 13.5kHz, flat envelope, a fresh spectrum every run — which is a
       microphone-shaped artifact, never a tone. Measured: a fresh
       AudioContext on WebKit is SUSPENDED (chromium's runs), and a gesture on
       the page beforehand does not change that; only resume() does. Ask, then
       say so rather than measure noise and blame the mesh. */
    if (ctx.state === 'suspended') await ctx.resume().catch(() => { /* checked next */ });
    if (ctx.state !== 'running') {
      throw new Error(`tone generator did not start — AudioContext ${ctx.state} at ${ctx.sampleRate}Hz (engine has no output device?)`);
    }
    const rate = ctx.sampleRate;
    const length = Math.ceil((ms / 1000) * rate);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * f * i) / rate) * 0.5;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    /* A tap on the SAME context: the generator's own word on what it
       rendered, readable later without MediaRecorder (WebKitGTK does not
       expose it at all) and without a second AudioContext (which could
       itself fail to pull — the very thing being measured). */
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    source.start();
    const w = window as unknown as { __testTxTrack: MediaStreamTrack; __testTxRate: number; __testTxAnalyser?: AnalyserNode };
    w.__testTxTrack = dest.stream.getAudioTracks()[0]!;
    w.__testTxAnalyser = analyser;
    /* Read back, not assumed: an engine may hand out a rate it never
       honours, and that is the first thing a wrong reading needs. */
    w.__testTxRate = ctx.sampleRate;
  }, { freq, durationMs });
}

/** Start transmission using the injected tone track. */
export async function startTx(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __testTxTrack?: MediaStreamTrack; mesh?: MeshInstance };
    if (!w.__testTxTrack || !w.mesh) throw new Error('no injected tone track or mesh');
    return w.mesh.beginTx(w.__testTxTrack);
  });
}

/** End transmission; the mesh swaps back to the silent carrier. */
export async function endTx(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { mesh?: MeshInstance }).mesh?.endTx();
  });
}

/**
 * Read the tone generator's own output through the tap on its context.
 * No reading or silence here means the engine never RENDERED the tone, and
 * anything the far side then hears is the engine's own garbage — not a mesh
 * bug. A clean reading here means the signal left the generator's graph
 * intact, so whatever the far side heard was mangled afterwards: the engine's
 * own track/encode path, or the wire.
 */
export async function measureTxTone(page: Page, samples = 6): Promise<{ freq: number; rms: number }> {
  return page.evaluate(async (n: number) => {
    const w = window as unknown as { __testTxAnalyser?: AnalyserNode; __testTxRate?: number };
    const analyser = w.__testTxAnalyser;
    if (!analyser) throw new Error('no tone tap — injectTxTrack did not run');
    const bucket = new Float32Array(analyser.fftSize);
    const rate = w.__testTxRate ?? 0;
    let best = 0, peak = 0;
    for (let k = 0; k < n; k++) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(bucket);
      let sum = 0;
      for (let i = 0; i < bucket.length; i++) sum += bucket[i]! * bucket[i]!;
      const rms = Math.sqrt(sum / bucket.length);
      if (rms > peak) peak = rms;
      if (rms > 0.01 && rate) {
        let crossings = 0, armed = false;
        for (let i = 0; i < bucket.length; i++) {
          const v = bucket[i]!;
          if (!armed && v < 0) armed = true;
          else if (armed && v > 0) { crossings++; armed = false; }
        }
        best = Math.max(best, (crossings * rate) / bucket.length);
      }
    }
    return { freq: Math.round(best), rms: Number(peak.toFixed(4)) };
  }, samples);
}

/** Record every remote audio element. Returns a stop handle. */
export async function startRecording(page: Page, slot?: number): Promise<string> {
  const handle = `rec_${Date.now()}`;
  await page.evaluate(({ h, want }: { h: string; want?: number }) => {
    const w = window as unknown as { [k: string]: unknown };
    const chunks: Blob[] = [];
    w.__testChunks = chunks;

    /* Record ONE peer, not the mix. Slots are room-global (peer ids are
       HMAC(secret, slot)), so the sender's own slot identifies its element
       here. Mixing every remote track works by accident with two peers and
       is wrong with three: the recording stops being the sender's stream and
       the analyser reports duration 0 instead of the truth. */
    const selector = typeof want === 'number' ? `audio[data-remote="${want}"]` : 'audio[data-remote]';
    const stream = new MediaStream();
    let matched = 0;
    for (const el of document.querySelectorAll<HTMLAudioElement>(selector)) {
      const src = el.srcObject;
      if (!(src instanceof MediaStream)) continue;
      matched++;
      for (const track of src.getTracks()) stream.addTrack(track);
    }
    if (stream.getTracks().length === 0) {
      throw new Error(
        `no remote tracks to record${typeof want === 'number' ? ` for UNIT-${want}` : ''} — mesh not linked`,
      );
    }
    (w as unknown as { __testMatched: number }).__testMatched = matched;

    /* WebKit has no webm/opus — fall back through what this engine records */
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error(`no supported recording format (webm/mp4/ogg) — engine: ${navigator.userAgent}`);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(100);
    w[h] = recorder;
  }, { h: handle, want: slot });
  return handle;
}

/**
 * Stop recording and return the audio as base64. A string crosses the
 * bridge intact; a raw ArrayBuffer arrives as a plain object.
 */
export async function stopRecording(page: Page, handle: string): Promise<string> {
  return page.evaluate((h: string) => new Promise<string>((resolve) => {
    const w = window as unknown as { [k: string]: unknown };
    const recorder = w[h] as MediaRecorder | undefined;
    const chunks = (w.__testChunks ?? []) as Blob[];
    if (!recorder) { resolve(''); return; }
    recorder.onstop = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(new Blob(chunks));
    };
    recorder.stop();
    delete w[h];
  }), handle);
}

/**
 * Analyze recorded audio: zero-crossing dominant frequency, active-region
 * duration (gated above the noise floor) and overall RMS.
 */
export async function analyzeAudio(page: Page, base64: string): Promise<AudioAnalysis> {
  if (!base64) throw new Error('empty recording — nothing was captured');
  const result = await page.evaluate(async (data: string) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const audioBuffer = await new AudioContext().decodeAudioData(bytes.buffer);
    const samples = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i]! * samples[i]!;
    const rms = Math.sqrt(sumSq / Math.max(1, samples.length));

    const gate = 0.02;
    let first = -1, last = -1;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i]!) > gate) {
        if (first < 0) first = i;
        last = i;
      }
    }

    let freq = 0, duration = 0, medianFreq = 0, glitches = 0;
    if (first >= 0 && last > first) {
      const active = last - first + 1;
      duration = (active / sampleRate) * 1000;
      /* one count per positive-going crossing (hysteresis at the gate) */
      let crossings = 0, armed = false;
      const marks: number[] = [];
      for (let i = Math.max(0, first - Math.round(sampleRate * 0.01)); i <= last; i++) {
        const v = samples[i]!;
        if (!armed && v < -gate) armed = true;
        else if (armed && v > gate) { crossings++; armed = false; marks.push(i); }
      }
      freq = crossings / (active / sampleRate);
      const gaps: number[] = [];
      for (let k = 1; k < marks.length; k++) gaps.push(marks[k]! - marks[k - 1]!);
      gaps.sort((a, b) => a - b);
      const median = gaps.length ? gaps[gaps.length >> 1]! : 0;
      medianFreq = median ? sampleRate / median : 0;
      glitches = median ? gaps.filter((g) => g > median * 1.5 || g < median * 0.5).length : 0;
    }
    return { freq, duration, rms, medianFreq, glitches };
  }, base64);

  return { ...result, passed: false };
}

/** Frequency (Hz), active duration (ms) and level must all match. */
export function verifyAudio(
  analysis: AudioAnalysis,
  expectedFreq: number,
  expectedDurationMs: number,
  { freqTolerance = 50, durationTolerance = 500, minRms = 0.01 } = {},
): boolean {
  return Math.abs(analysis.freq - expectedFreq) <= freqTolerance
    && Math.abs(analysis.duration - expectedDurationMs) <= durationTolerance
    && analysis.rms >= minRms;
}

/** Persist the base64 recording next to the test artifacts. */
export async function saveAudio(base64: string, label: string): Promise<string> {
  const fs = await import('fs');
  const path = await import('path');
  const dir = 'test-results/audio';
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${label}-${Date.now()}.mka`);
  fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
  return filepath;
}