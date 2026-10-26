import workletUrl from "./pcm-worklet.ts?worker&url";

export type ChunkHandler = (pcm: ArrayBuffer, rms: number) => void;

/** Microphone capture that emits 100 ms chunks of 16 kHz int16 PCM. */
export class Mic {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;

  async start(onChunk: ChunkHandler): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(this.ctx, "pcm-16k");
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) =>
      onChunk(e.data.pcm, e.data.rms);

    // Route through a muted gain so the graph keeps pulling the worklet.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.ctx.createMediaStreamSource(this.stream).connect(this.node).connect(mute).connect(this.ctx.destination);
  }

  async stop(): Promise<void> {
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = this.stream = this.node = undefined;
  }
}
