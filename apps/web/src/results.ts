export type Sample = { t: number; chars: number };

const RAW_WINDOW_S = 3;

/** Monkeytype's definition: a "word" is 5 characters, spaces included. */
export function wpm(chars: number, seconds: number): number {
  return seconds > 0 ? chars / 5 / (seconds / 60) : 0;
}

export function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Line chart of cumulative wpm (main colour) and short-window raw wpm (sub colour). */
export function renderChart(svg: SVGSVGElement, samples: Sample[]): void {
  const W = 800;
  const H = 200;
  const pad = { l: 40, r: 10, t: 12, b: 26 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (samples.length < 2) {
    svg.innerHTML = "";
    return;
  }

  const series = samples.map((s, i) => {
    const prev = samples[Math.max(0, i - RAW_WINDOW_S)];
    return {
      t: s.t,
      wpm: wpm(s.chars, s.t),
      raw: s.t > prev.t ? wpm(s.chars - prev.chars, s.t - prev.t) : 0,
    };
  });
  const tMax = series[series.length - 1].t;
  const yMax = Math.max(60, Math.ceil(Math.max(...series.map((p) => Math.max(p.wpm, p.raw))) / 50) * 50);
  const x = (t: number) => pad.l + (t / tMax) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const path = (key: "wpm" | "raw") =>
    series.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");

  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = Math.round(yMax * f);
      return `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="axis" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    })
    .join("");
  const ticks = Array.from({ length: 5 }, (_, i) => (tMax * i) / 4)
    .map((t) => `<text class="axis" x="${x(t)}" y="${H - 6}" text-anchor="middle">${Math.round(t)}</text>`)
    .join("");

  svg.innerHTML = `${grid}${ticks}
    <path class="line raw" d="${path("raw")}"/>
    <path class="line wpm" d="${path("wpm")}"/>`;
}
