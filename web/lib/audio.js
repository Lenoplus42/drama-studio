// Audio helpers for Drama Studio.
// The server sends each chunk as a complete mono 16-bit PCM WAV. We read the PCM
// out of each chunk ourselves (no resampling), schedule it gaplessly for live
// playback, and re-wrap the joined PCM in a single fresh WAV header for download.

/** Parse a PCM16 WAV into { sampleRate, channels, samples: Int16Array }. */
export function parseWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Chunk is not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      const format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format !== 1 || bits !== 16) throw new Error("Expected 16-bit PCM WAV");
    } else if (id === "data") {
      const end = Math.min(body + size, bytes.byteLength);
      // slice() copies, which also guarantees 2-byte alignment for Int16Array.
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + end - ((end - body) % 2)));
      if (!sampleRate) throw new Error("WAV data before fmt chunk");
      return { sampleRate, channels, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Join PCM16 mono chunks and write one WAV header in front of them. */
export function encodeWav(chunks, sampleRate) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, total * 2, true);
  const out = new Int16Array(buffer, 44, total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Peak envelope for drawing: one value (0..1) per `step` samples. */
export function peaks(samples, step) {
  const out = new Float32Array(Math.ceil(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    let max = 0;
    const end = Math.min(samples.length, (i + 1) * step);
    for (let j = i * step; j < end; j++) {
      const value = Math.abs(samples[j]);
      if (value > max) max = value;
    }
    out[i] = max / 32768;
  }
  return out;
}

export const PEAK_RATE = 100; // peak values per second of audio

/**
 * Plays chunks in arrival order on one AudioContext timeline.
 * If generation falls behind playback, the next chunk starts after a short
 * re-buffer instead of overlapping.
 */
export class StreamPlayer {
  constructor(context, destination, { lead = 0.12, rebuffer = 0.3 } = {}) {
    this.context = context;
    this.destination = destination;
    this.lead = lead;
    this.rebuffer = rebuffer;
    this.nextTime = 0;
    this.sources = new Set();
    this.timeline = []; // { at: context time, offset: seconds into take, duration }
    this.queuedSeconds = 0;
    this.stalls = 0;
  }

  enqueue(samples, sampleRate) {
    if (!samples.length) return;
    const { context } = this;
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    const now = context.currentTime;
    if (!this.timeline.length) this.nextTime = now + this.lead;
    else if (this.nextTime < now + 0.02) { this.nextTime = now + this.rebuffer; this.stalls++; }
    source.start(this.nextTime);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    this.timeline.push({ at: this.nextTime, offset: this.queuedSeconds, duration: buffer.duration });
    this.nextTime += buffer.duration;
    this.queuedSeconds += buffer.duration;
  }

  /** Seconds of the take heard so far. */
  position() {
    const now = this.context.currentTime;
    let heard = 0;
    for (const part of this.timeline) {
      if (part.at > now) break;
      heard = part.offset + Math.min(now - part.at, part.duration);
    }
    return heard;
  }

  /** True once every queued chunk has finished playing. */
  drained() {
    return this.timeline.length > 0 && this.context.currentTime >= this.nextTime;
  }

  stop() {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
  }
}
