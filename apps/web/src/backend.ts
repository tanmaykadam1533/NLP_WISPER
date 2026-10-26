export type ServerMessage =
  | { type: "ready"; model: string; language: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; audio_s: number; latency_ms: number }
  | { type: "flushed" };

// Open the app with ?debug to log every server message to the console.
const DEBUG = new URLSearchParams(location.search).has("debug");

type Handlers = {
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
};

/** WebSocket to the FastAPI backend, reconnecting with backoff. */
export class Backend {
  private ws: WebSocket | null = null;
  private retries = 0;

  constructor(private handlers: Handlers) {
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (this.isOpen) this.ws!.send(pcm);
  }

  sendControl(type: "flush" | "reset"): void {
    if (this.isOpen) this.ws!.send(JSON.stringify({ type }));
  }

  private connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/transcribe`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => (this.retries = 0);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      if (DEBUG) console.log(`[ws ${(performance.now() / 1000).toFixed(2)}s]`, msg);
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onClose();
      setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** this.retries++));
    };
    this.ws = ws;
  }
}
