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
  passed: boolean;
}

/** Inject a pure sine tone as a MediaStreamTrack the mesh can transmit. */
export async function injectTxTrack(page: Page, freq: number, durationMs: number): Promise<void> {
  await page.evaluate(({ freq: f, durationMs: ms }) => {
    const ctx = new AudioContext({ sampleRate: 48000 });
    const length = Math.ceil((ms / 1000) * 48000);
    const buffer = ctx.createBuffer(1, length, 48000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * f * i) / 48000) * 0.5;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    source.start();
    (window as unknown as { __testTxTrack: MediaStreamTrack }).__testTxTrack = dest.stream.getAudioTracks()[0]!;
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
    const audioBuffer = await new AudioContext({ sampleRate: 48000 }).decodeAudioData(bytes.buffer);
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

    let freq = 0, duration = 0;
    if (first >= 0 && last > first) {
      const active = last - first + 1;
      duration = (active / sampleRate) * 1000;
      /* one count per positive-going crossing (hysteresis at the gate) */
      let crossings = 0, armed = false;
      for (let i = Math.max(0, first - Math.round(sampleRate * 0.01)); i <= last; i++) {
        const v = samples[i]!;
        if (!armed && v < -gate) armed = true;
        else if (armed && v > gate) { crossings++; armed = false; }
      }
      freq = crossings / (active / sampleRate);
    }
    return { freq, duration, rms };
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