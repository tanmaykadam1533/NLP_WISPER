/**
 * Renders text one character span at a time, Monkeytype style.
 *
 * `set()` gives the text that should be on screen; every animation frame the
 * view "backspaces" to the common prefix with what's shown, then types the
 * rest, faster the further behind it is. Characters before `committed` are
 * final transcript, the rest is a partial Whisper may still revise.
 */
export class Typer {
  private spans: HTMLSpanElement[] = [];
  private shown = "";
  private target = "";
  private committed = 0;
  private paintedCommitted = 0;
  private raf = 0;

  constructor(
    private words: HTMLElement,
    private caret: HTMLElement,
    private probe: HTMLElement,
  ) {
    this.place();
  }

  get text(): string {
    return this.target;
  }

  set(target: string, committed: number): void {
    this.target = target;
    this.committed = committed;
    if (!this.raf) this.raf = requestAnimationFrame(this.step);
  }

  clear(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.spans.forEach((s) => s.remove());
    this.spans = [];
    this.shown = this.target = "";
    this.committed = this.paintedCommitted = 0;
    this.place();
  }

  private step = (): void => {
    this.raf = 0;
    const { shown, target } = this;
    let p = 0;
    const max = Math.min(shown.length, target.length);
    while (p < max && shown[p] === target[p]) p++;

    if (shown.length > p) {
      const k = speed(shown.length - p);
      for (let i = 0; i < k; i++) this.spans.pop()!.remove();
      this.shown = shown.slice(0, shown.length - k);
    } else if (target.length > shown.length) {
      const k = speed(target.length - shown.length);
      const frag = document.createDocumentFragment();
      for (let i = shown.length; i < shown.length + k; i++) {
        const span = document.createElement("span");
        span.textContent = target[i];
        frag.append(span);
        this.spans.push(span);
      }
      this.words.insertBefore(frag, this.caret);
      this.shown = target.slice(0, shown.length + k);
    }

    this.paint();
    this.place();
    if (this.shown !== this.target) this.raf = requestAnimationFrame(this.step);
  };

  private paint(): void {
    const from = Math.min(this.paintedCommitted, this.committed);
    for (let i = from; i < this.spans.length; i++) {
      this.spans[i].className = i < this.committed ? "final" : "partial";
    }
    this.paintedCommitted = this.committed;
  }

  /** Move the caret after the last char and scroll so it stays on the bottom (3rd) line. */
  private place(): void {
    const last = this.spans[this.spans.length - 1];
    const left = last ? last.offsetLeft + last.offsetWidth : this.probe.offsetLeft;
    const top = (last ?? this.probe).offsetTop;
    this.caret.style.transform = `translate(${left}px, ${top}px)`;

    const lineHeight = parseFloat(getComputedStyle(this.words).lineHeight);
    const line = Math.round((top - this.probe.offsetTop) / lineHeight);
    this.words.style.transform = `translateY(${-Math.max(0, line - 2) * lineHeight}px)`;
  }
}

/** Chars per frame: one at a time when caught up, catching up within ~8 frames. */
function speed(backlog: number): number {
  return Math.max(1, Math.ceil(backlog / 8));
}
