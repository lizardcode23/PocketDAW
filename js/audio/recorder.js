// Microphone / line input capture.
//
// The stream is tapped by an AudioWorklet so blocks arrive on the audio
// thread and takes line up with the transport. Where worklets are not
// available we fall back to a ScriptProcessor, which is deprecated but still
// works everywhere; it can drop blocks under load, so it is the second choice.

import { getContext, getMaster, unlock } from './context.js';

let stream = null;
let source = null;
let tap = null;            // worklet or script processor
let analyser = null;
let monitorGain = null;
let chunks = [];
let channelCount = 1;
let capturing = false;
let startedAt = 0;
let workletReady = false;

export const isCapturing = () => capturing;
export const hasInput = () => !!stream;

/**
 * Ask for input. Echo cancellation and friends are disabled — they are tuned
 * for speech calls and wreck music.
 */
export async function openInput() {
  if (stream) return stream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot record audio');
  }
  await unlock();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 1 },
    },
  });

  const ctx = getContext();
  source = ctx.createMediaStreamSource(stream);
  channelCount = Math.max(1, Math.min(2, source.channelCount || 1));

  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  monitorGain = ctx.createGain();
  monitorGain.gain.value = 0;          // silent until monitoring is switched on
  source.connect(monitorGain);
  monitorGain.connect(getMaster());

  await attachTap(ctx);
  return stream;
}

async function attachTap(ctx) {
  if (ctx.audioWorklet && !workletReady) {
    try {
      await ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
      workletReady = true;
    } catch {
      workletReady = false;
    }
  }

  if (workletReady) {
    tap = new AudioWorkletNode(ctx, 'pocket-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channelCount],
    });
    tap.port.onmessage = (e) => { if (capturing) chunks.push(e.data); };
  } else {
    const size = 2048;
    tap = ctx.createScriptProcessor(size, channelCount, channelCount);
    tap.onaudioprocess = (e) => {
      if (!capturing) return;
      const block = [];
      for (let c = 0; c < channelCount; c++) {
        block.push(new Float32Array(e.inputBuffer.getChannelData(c)));
      }
      chunks.push(block);
    };
    // A ScriptProcessor only runs while connected to something.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    tap.connect(sink);
    sink.connect(ctx.destination);
  }
  source.connect(tap);
}

export function closeInput() {
  stopCapture();
  try { source && source.disconnect(); } catch { /* gone */ }
  try { tap && tap.disconnect(); } catch { /* gone */ }
  try { monitorGain && monitorGain.disconnect(); } catch { /* gone */ }
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null; source = null; tap = null; analyser = null; monitorGain = null;
}

export function setMonitor(on) {
  if (monitorGain) monitorGain.gain.value = on ? 1 : 0;
}

/** Peak level of the input right now, 0..1 — for the meter. */
export function inputLevel() {
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** Begin capturing. Returns the AudioContext time of the first sample. */
export function startCapture() {
  if (!tap) throw new Error('No input open');
  chunks = [];
  capturing = true;
  startedAt = getContext().currentTime;
  if (tap.port) tap.port.postMessage('start');
  return startedAt;
}

/** Stop and assemble the take. Returns { buffer, startedAt } or null. */
export function stopCapture() {
  if (!capturing) return null;
  capturing = false;
  if (tap && tap.port) tap.port.postMessage('stop');

  const total = chunks.reduce((a, block) => a + block[0].length, 0);
  if (!total) { chunks = []; return null; }

  const ctx = getContext();
  const channels = chunks[0].length;
  const buffer = ctx.createBuffer(channels, total, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const out = buffer.getChannelData(c);
    let offset = 0;
    for (const block of chunks) {
      out.set(block[Math.min(c, block.length - 1)], offset);
      offset += block[0].length;
    }
  }
  chunks = [];
  return { buffer, startedAt };
}

/** Trim silence from the head and tail, keeping a little breathing room. */
export function trimSilence(buffer, ctx, threshold = 0.004) {
  const len = buffer.length;
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const loudAt = (i) => {
    let peak = 0;
    for (const ch of chans) peak = Math.max(peak, Math.abs(ch[i]));
    return peak;
  };
  let start = 0;
  while (start < len && loudAt(start) < threshold) start++;
  let end = len - 1;
  while (end > start && loudAt(end) < threshold) end--;
  if (start >= end) return { buffer, trimmedStart: 0 };

  const pad = Math.floor(buffer.sampleRate * 0.02);
  start = Math.max(0, start - pad);
  end = Math.min(len - 1, end + pad);
  const out = ctx.createBuffer(buffer.numberOfChannels, end - start + 1, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.getChannelData(c).set(chans[c].subarray(start, end + 1));
  }
  return { buffer: out, trimmedStart: start / buffer.sampleRate };
}
