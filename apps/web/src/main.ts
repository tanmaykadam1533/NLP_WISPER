import "@fontsource/roboto-mono/400.css";
import "@fontsource/lexend-deca/400.css";
import "./style.css";

import { Mic } from "./audio";
import { Backend, type ServerMessage } from "./backend";
import { countWords, formatTime, renderChart, wpm, type Sample } from "./results";
import { Typer } from "./typer";

type State = "idle" | "listening" | "stopping" | "result";

const THEMES = ["serika_dark", "nord", "dracula", "carbon"] as const;
const FLUSH_TIMEOUT_MS = 5000;

const $ = <T extends Element = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;

const typer = new Typer($("words"), $("caret"), $("probe"));
const mic = new Mic();

let state: State = "idle";
let finals: string[] = [];
let partial = "";
let latencies: number[] = [];
let samples: Sample[] = [];
let startedAt = 0;
let endedAt = 0;
let ticker = 0;
let flushTimer = 0;
let level = 0;
let model = "";

const backend = new Backend({ onMessage, onClose });

function setState(next: State): void {
  state = next;
  document.body.dataset.state = next;
  $("test").hidden = next === "result";
  $("result").hidden = next !== "result";
}

function setConn(conn: "connecting" | "ready" | "offline", text: string): void {
  $("conn").dataset.state = conn;
  $("conn-text").textContent = text;
}

function showError(message: string | null): void {
  $("error").hidden = !message;
  $("error").textContent = message ?? "";
}

function transcript(): string {
  return [...finals, partial].filter(Boolean).join(" ");
}

function render(): void {
  typer.set(transcript(), finals.join(" ").length);
}

function onMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case "ready":
      model = msg.model.split("/").pop()!.replace(/-mlx$/, "");
      $("cfg-model").textContent = model;
      $("cfg-lang").textContent = msg.language || "auto";
      setConn("ready", "ready");
      break;
    case "partial":
      if (state !== "listening" && state !== "stopping") return;
      partial = msg.text;
      render();
      break;
    case "final":
      if (state !== "listening" && state !== "stopping") return;
      if (msg.text) {
        finals.push(msg.text);
        latencies.push(msg.latency_ms);
      }
      partial = "";
      render();
      break;
    case "flushed":
      if (state === "stopping") showResult();
      break;
  }
}

function onClose(): void {
  setConn("offline", "backend offline");
  if (state === "listening") void stop();
  if (state === "stopping") showResult();
}

async function start(): Promise<void> {
  if (!backend.isOpen) {
    showError("backend not connected — is the api running?");
    return;
  }
  showError(null);
  resetSession();
  backend.sendControl("reset");
  try {
    await mic.start((pcm, rms) => {
      backend.sendAudio(pcm);
      level = Math.max(rms, level * 0.6);
      $("level-bar").style.transform = `scaleX(${Math.min(1, level * 6)})`;
    });
  } catch (err) {
    showError(`microphone unavailable: ${(err as Error).message}`);
    return;
  }
  startedAt = performance.now();
  setState("listening");
  ticker = window.setInterval(tick, 250);
}

async function stop(): Promise<void> {
  if (state !== "listening") return;
  endedAt = performance.now();
  setState("stopping");
  clearInterval(ticker);
  await mic.stop();
  level = 0;
  $("level-bar").style.transform = "scaleX(0)";
  backend.sendControl("flush");
  flushTimer = window.setTimeout(showResult, FLUSH_TIMEOUT_MS);
}

function tick(): void {
  const elapsed = (performance.now() - startedAt) / 1000;
  const text = transcript();
  while (samples.length < Math.floor(elapsed)) samples.push({ t: samples.length + 1, chars: text.length });
  $("live-time").textContent = formatTime(elapsed);
  $("live-wpm").textContent = String(Math.round(wpm(text.length, elapsed)));
  $("live-words").textContent = String(countWords(text));
}

function showResult(): void {
  if (state !== "stopping") return;
  clearTimeout(flushTimer);
  const text = transcript();
  const seconds = (endedAt - startedAt) / 1000;
  const chart = [...samples, { t: seconds, chars: text.length }];

  $("r-wpm").textContent = String(Math.round(wpm(text.length, seconds)));
  $("r-time").textContent = formatTime(seconds);
  $("r-words").textContent = String(countWords(text));
  $("r-chars").textContent = String(text.length);
  $("r-utts").textContent = String(finals.length);
  $("r-latency").textContent = latencies.length
    ? `${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`
    : "—";
  $("r-model").textContent = model || "—";
  $("r-text").textContent = text || "(nothing heard)";
  setState("result");
  renderChart($<SVGSVGElement>("chart"), chart);
}

function resetSession(): void {
  finals = [];
  partial = "";
  latencies = [];
  samples = [];
  typer.clear();
  $("live-time").textContent = "0:00";
  $("live-wpm").textContent = "0";
  $("live-words").textContent = "0";
}

async function reset(): Promise<void> {
  clearInterval(ticker);
  clearTimeout(flushTimer);
  if (state === "listening") await mic.stop();
  $("level-bar").style.transform = "scaleX(0)";
  backend.sendControl("reset");
  resetSession();
  showError(null);
  setState("idle");
}

function toggle(): void {
  if (state === "idle") void start();
  else if (state === "listening") void stop();
  else if (state === "result") void reset().then(start);
}

document.addEventListener("keydown", (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void reset();
  }
});

$("words-wrap").addEventListener("click", toggle);
$("restart").addEventListener("click", () => void reset());
$("again").addEventListener("click", () => void reset().then(start));
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(transcript());
  $("copy").classList.add("done");
  setTimeout(() => $("copy").classList.remove("done"), 1200);
});
// Keep focus off buttons so space always toggles instead of re-clicking them.
document.querySelectorAll("button").forEach((b) => b.addEventListener("mouseup", () => b.blur()));

function setTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  document.querySelectorAll<HTMLButtonElement>("#themes button").forEach((b) => {
    b.classList.toggle("active", b.dataset.theme === theme);
  });
}

for (const theme of THEMES) {
  const btn = document.createElement("button");
  btn.dataset.theme = theme;
  btn.textContent = theme.replace("_", " ");
  btn.addEventListener("click", () => setTheme(theme));
  $("themes").append(btn);
}
setTheme(localStorage.getItem("theme") ?? THEMES[0]);
setState("idle");
