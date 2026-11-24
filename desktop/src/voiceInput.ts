/** Microphone recording converted to 16 kHz mono WAV — the format whisper.cpp reads. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.start();
  }

  cancel(): void {
    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach(track => track.stop());
    this.recorder = null; this.stream = null; this.chunks = [];
  }

  /** Stop and return base64 WAV (16 kHz, mono, 16-bit). */
  async stop(): Promise<string> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Запись не идёт");
    const done = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.stop();
    await done;
    this.stream?.getTracks().forEach(track => track.stop());
    const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.recorder = null; this.stream = null; this.chunks = [];
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    void context.close();
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return toWavBase64(rendered.getChannelData(0), rate);
  }
}

export function toWavBase64(samples: Float32Array, rate: number): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
