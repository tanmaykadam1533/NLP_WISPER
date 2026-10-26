// AudioWorklet: downsample the mic to 16 kHz mono int16 and post 100 ms chunks.
// Runs in AudioWorkletGlobalScope, which TS's DOM lib doesn't describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const TARGET_RATE = 16_000;
const CHUNK = TARGET_RATE / 10;

class Pcm16kProcessor extends AudioWorkletProcessor {
  private ratio = sampleRate / TARGET_RATE;
  // Next output position, in input samples relative to the current block.
  // In [-1, 0) it lies between the previous block's last sample and input[0].
  private t = 0;
  private prev = 0;
  private out = new Int16Array(CHUNK);
  private filled = 0;
  private sumSq = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    const n = input.length;

    while (this.t <= n - 1) {
      const i = Math.floor(this.t);
      const frac = this.t - i;
      const s0 = i < 0 ? this.prev : input[i];
      const s1 = i + 1 < n ? input[i + 1] : s0;
      this.push(s0 + (s1 - s0) * frac);
      this.t += this.ratio;
    }
    this.t -= n;
    this.prev = input[n - 1];
    return true;
  }

  private push(sample: number): void {
    const s = Math.max(-1, Math.min(1, sample));
    this.sumSq += s * s;
    this.out[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.filled === CHUNK) {
      const rms = Math.sqrt(this.sumSq / CHUNK);
      this.port.postMessage({ pcm: this.out.buffer, rms }, [this.out.buffer]);
      this.out = new Int16Array(CHUNK);
      this.filled = 0;
      this.sumSq = 0;
    }
  }
}

registerProcessor("pcm-16k", Pcm16kProcessor);
