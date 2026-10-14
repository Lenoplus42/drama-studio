"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { generateScene, audioBytes } from "../api.js";
import { encodeWav, parseWav, peaks as peakEnvelope, PEAK_RATE, StreamPlayer } from "../lib/audio.js";
import {
  CAST_COLORS, EMOTIONS, MAX_CAST, MAX_CHARS, MAX_LINES, PRESETS,
  imageToDataUrl, newId, parseScript, parseWrittenScene, sceneFromPreset, toPlainScript, toRequestLines, validate,
} from "../lib/script.js";
import {
  CloseIcon, DownIcon, DownloadIcon, GearIcon, ImageIcon, PasteIcon, PauseIcon, PlayIcon, PlusIcon, QuillIcon, StopIcon, UpIcon,
} from "./icons.jsx";

const DEFAULT_API = process.env.NEXT_PUBLIC_DRAMA_API_URL || "http://127.0.0.1:8765";
const STORAGE_KEY = "drama-studio:api-url";
const RECORDED_TAKE_URL = "/samples/recorded-take.wav";

const storage = {
  get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { value ? window.localStorage.setItem(key, value) : window.localStorage.removeItem(key); } catch { /* private mode */ } },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmtTime = (seconds) => {
  const s = Math.max(0, seconds || 0);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const fmtSec = (seconds) => `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
const fmtLap = (seconds) => {
  const s = Math.max(0, seconds || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
};
const fmtLatency = (ms) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : fmtSec(ms / 1000));
const sceneKey = (scene) => JSON.stringify(toRequestLines(scene));

function describeError(error, apiUrl) {
  const http = /^HTTP (\d+): ([\s\S]*)$/.exec(error?.message || "");
  if (http) {
    const status = Number(http[1]);
    if (status === 409) return "The voice server is still finishing another take. Try again in a moment.";
    if (status === 422) {
      try {
        const detail = JSON.parse(http[2]).detail;
        if (Array.isArray(detail)) {
          return "The server rejected the script: " + detail
            .map((d) => (typeof d.loc?.[2] === "number" ? `line ${d.loc[2] + 1}: ` : "") + d.msg)
            .join("; ");
        }
      } catch { /* fall through */ }
      return "The server rejected the script. Check each line's length and speaker.";
    }
    return `The voice server answered HTTP ${status}. Check its log for details.`;
  }
  if (error instanceof TypeError) {
    return `Can't reach the voice server at ${apiUrl}. Start it, or change the address in Server settings.`;
  }
  if (/ended before completion/.test(error?.message || "")) {
    return "The connection dropped before the take finished, so it wasn't saved. Try again.";
  }
  return error?.message || "Generation failed.";
}

/* ------------------------------------------------------------------ */

export default function Studio() {
  const [scene, setScene] = useState(() => sceneFromPreset(PRESETS.find((preset) => preset.id === "box-box")));
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [health, setHealth] = useState({ status: "checking" });
  const [run, setRun] = useState({ phase: "idle" });
  const [takes, setTakes] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const saved = [
      { id: "saved-box-original", label: "Box this lap — original", url: "/samples/box-original.wav" },
      { id: "saved-box-edited", label: "Box this lap — edited gap", url: "/samples/box-edited.wav" },
    ];
    Promise.all(saved.map(async (item) => {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error("Saved audio unavailable");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const { samples, sampleRate } = parseWav(bytes);
      return { ...item, number: 0, recorded: true, backend: "recorded",
        duration: samples.length / sampleRate,
        peaks: peakEnvelope(samples, Math.round(sampleRate / PEAK_RATE)),
        key: item.id, cast: [], lineCount: 6 };
    })).then((savedTakes) => {
      if (cancelled) return;
      setTakes((previous) => [...previous, ...savedTakes.filter((item) => !previous.some((take) => take.id === item.id))]);
      setSelectedId((current) => current || savedTakes[0].id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [selectedId, setSelectedId] = useState(null);
  const [nowPlaying, setNowPlaying] = useState(null); // "stream" | take id | null
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [focusId, setFocusId] = useState(null);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const audioElRef = useRef(null);
  const abortRef = useRef(null);
  const liveRef = useRef(null);
  const takesRef = useRef(takes);
  const selectedRef = useRef(null);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const takeCounter = useRef(0);

  const selectedTake = takes.find((take) => take.id === selectedId) || null;
  takesRef.current = takes;
  selectedRef.current = selectedTake;

  const generating = run.phase === "connecting" || run.phase === "streaming";
  const problems = useMemo(() => validate(scene), [scene]);
  const currentKey = useMemo(() => sceneKey(scene), [scene]);
  const backend = run.backend || health.backend;
  const isMock = backend === "mock";

  /* ---------- server address & health ---------- */

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("api");
    const saved = storage.get(STORAGE_KEY);
    if (fromQuery) setApiUrl(fromQuery.replace(/\/$/, ""));
    else if (saved) setApiUrl(saved);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    async function check() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(`${apiUrl.replace(/\/$/, "")}/health`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!cancelled) setHealth({ status: body.ready ? "online" : "starting", backend: body.backend, busy: !!body.busy });
      } catch {
        if (!cancelled) setHealth({ status: "offline" });
      } finally {
        clearTimeout(timeout);
        if (!cancelled) timer = setTimeout(check, 4000);
      }
    }
    setHealth({ status: "checking" });
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiUrl]);

  /* ---------- audio graph ---------- */

  const ensureAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const context = new AudioCtx();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(context.destination);
      const media = context.createMediaElementSource(audioElRef.current);
      media.connect(analyser);
      audioCtxRef.current = context;
      analyserRef.current = analyser;
    }
    const context = audioCtxRef.current;
    if (context.state === "suspended") context.resume();
    return context;
  }, []);

  const stopStreamPlayback = useCallback(() => {
    const live = liveRef.current;
    if (live) { live.player.stop(); live.active = false; }
  }, []);

  /* ---------- generation ---------- */

  const perform = useCallback(async () => {
    if (abortRef.current) return;
    const lines = toRequestLines(scene);
    if (validate(scene).length) return;
    const context = ensureAudio();
    audioElRef.current?.pause();
    stopStreamPlayback();
    setNotice(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const live = {
      player: new StreamPlayer(context, analyserRef.current),
      chunks: [], peaks: [], sampleRate: 44100, backend: null,
      startedAt: performance.now(), firstAudioMs: null, received: 0, count: 0,
      truncated: false, active: true, key: sceneKey(scene), snapshot: scene,
      carryMax: 0, carryCount: 0,
    };
    liveRef.current = live;
    setNowPlaying("stream");
    setRun({ phase: "connecting" });

    let attempt = 0;
    while (true) {
      try {
        for await (const event of generateScene(apiUrl, lines, controller.signal)) {
          if (event.type === "start") {
            live.sampleRate = event.sample_rate;
            live.backend = event.backend;
            setRun({ phase: "connecting", backend: event.backend });
          } else if (event.type === "audio") {
            const { samples, sampleRate } = parseWav(audioBytes(event));
            live.player.enqueue(samples, sampleRate);
            live.chunks.push(samples);
            pushPeaks(live, samples, Math.max(1, Math.round(sampleRate / PEAK_RATE)));
            live.received += samples.length / sampleRate;
            live.count += 1;
            if (live.firstAudioMs == null) live.firstAudioMs = performance.now() - live.startedAt;
            setRun({ phase: "streaming", backend: live.backend, received: live.received, count: live.count, firstAudioMs: live.firstAudioMs });
          } else if (event.type === "done") {
            live.truncated = !!event.truncated;
          }
        }
        break;
      } catch (error) {
        const busy = /^HTTP 409/.test(error?.message || "");
        if (busy && live.count === 0 && attempt < 4 && !controller.signal.aborted) {
          attempt += 1;
          setRun({ phase: "connecting", waiting: true });
          await sleep(900);
          if (!controller.signal.aborted) continue;
        }
        abortRef.current = null;
        live.player.stop();
        live.active = false;
        setNowPlaying(null);
        if (error?.name === "AbortError" || controller.signal.aborted) setRun({ phase: "cancelled" });
        else setRun({ phase: "error", message: describeError(error, apiUrl) });
        return;
      }
    }

    abortRef.current = null;
    if (live.carryCount) { live.peaks.push(live.carryMax / 32768); live.carryCount = 0; }
    const renderMs = performance.now() - live.startedAt;
    const blob = encodeWav(live.chunks, live.sampleRate);
    const number = ++takeCounter.current;
    const take = {
      id: newId(), number, label: `Conversation ${number}`, url: URL.createObjectURL(blob), blob,
      duration: live.received, backend: live.backend, firstAudioMs: live.firstAudioMs, renderMs,
      truncated: live.truncated, peaks: Float32Array.from(live.peaks), key: live.key,
      cast: live.snapshot.cast.map((c) => c.name), lineCount: lines.length,
    };
    live.takeId = take.id;
    setTakes((previous) => [...previous, take]);
    setSelectedId(take.id);
    setRun({ phase: "done", backend: live.backend, takeId: take.id, renderMs, firstAudioMs: live.firstAudioMs, duration: live.received, truncated: live.truncated });
  }, [apiUrl, ensureAudio, scene, stopStreamPlayback]);

  const stop = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    stopStreamPlayback();
    audioElRef.current?.pause();
    setNowPlaying(null);
  }, [stopStreamPlayback]);

  /* ---------- take transport ---------- */

  const playTake = useCallback((take) => {
    if (!take) return;
    ensureAudio();
    stopStreamPlayback();
    const audio = audioElRef.current;
    if (audio.dataset.take !== take.id) {
      audio.src = take.url;
      audio.dataset.take = take.id;
    } else if (audio.ended) {
      audio.currentTime = 0;
    }
    setSelectedId(take.id);
    audio.play().then(() => setNowPlaying(take.id)).catch(() => setNowPlaying(null));
  }, [ensureAudio, stopStreamPlayback]);

  const toggleTake = useCallback((take) => {
    const audio = audioElRef.current;
    if (nowPlaying === take.id && !audio.paused) { audio.pause(); setNowPlaying(null); }
    else playTake(take);
  }, [nowPlaying, playTake]);

  const seek = useCallback((event) => {
    const take = selectedRef.current;
    if (!take || liveRef.current?.active) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const audio = audioElRef.current;
    if (audio.dataset.take !== take.id) { playTake(take); }
    const apply = () => { audio.currentTime = ratio * take.duration; };
    if (audio.readyState >= 1) apply(); else audio.addEventListener("loadedmetadata", apply, { once: true });
  }, [playTake]);

  const loadRecordedTake = useCallback(async () => {
    try {
      const response = await fetch(RECORDED_TAKE_URL);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const { samples, sampleRate } = parseWav(bytes);
      const blob = new Blob([bytes], { type: "audio/wav" });
      const take = {
        id: newId(), number: 0, label: "Recorded take", url: URL.createObjectURL(blob), blob,
        duration: samples.length / sampleRate, backend: "recorded", recorded: true,
        peaks: peakEnvelope(samples, Math.round(sampleRate / PEAK_RATE)),
        key: "recorded", cast: [], lineCount: 0,
      };
      setTakes((previous) => [...previous, take]);
      setRun({ phase: "idle" });
      playTake(take);
    } catch {
      setNotice({ tone: "error", text: "Couldn't load the recorded take." });
    }
  }, [playTake]);

  /* ---------- drawing loop: waveform, playhead, stage light ---------- */

  useEffect(() => {
    let frame;
    const levels = new Float32Array(1024);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const live = liveRef.current;
      const audio = audioElRef.current;
      const take = selectedRef.current;

      // Stage light follows the actual output level.
      const analyser = analyserRef.current;
      if (analyser && stageRef.current) {
        analyser.getFloatTimeDomainData(levels);
        let sum = 0;
        for (let i = 0; i < levels.length; i++) sum += levels[i] * levels[i];
        const level = Math.min(1, Math.sqrt(sum / levels.length) * 5);
        stageRef.current.style.setProperty("--level", level.toFixed(3));
      }

      if (live?.active && !abortRef.current && live.player.drained()) {
        live.active = false;
        setNowPlaying((current) => (current === "stream" ? null : current));
      }

      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const g = canvas.getContext("2d");
      g.clearRect(0, 0, width, height);

      let data = null;
      let span = 0;
      let position = 0;
      let filled = 0;
      if (live?.active) {
        data = live.peaks;
        filled = live.received;
        span = Math.max(live.received * 1.08, 8);
        position = live.player.position();
      } else if (take) {
        data = take.peaks;
        filled = take.duration;
        span = take.duration;
        position = audio && audio.dataset.take === take.id ? audio.currentTime : 0;
      }
      if (!data || !data.length || !span) return;

      const bar = 3 * dpr;
      const bars = Math.floor(width / bar);
      const mid = height / 2;
      const styles = getComputedStyle(canvas);
      const played = styles.getPropertyValue("--wave-played").trim() || "#d9ae55";
      const ahead = styles.getPropertyValue("--wave-ahead").trim() || "rgba(239,231,218,.35)";
      for (let i = 0; i < bars; i++) {
        const t0 = (i / bars) * span;
        if (t0 > filled) break;
        const t1 = ((i + 1) / bars) * span;
        let peak = 0;
        const end = Math.min(data.length, Math.ceil(t1 * PEAK_RATE));
        for (let j = Math.floor(t0 * PEAK_RATE); j < end; j++) if (data[j] > peak) peak = data[j];
        const h = Math.max(dpr, Math.pow(peak, 0.75) * height * 0.92);
        g.fillStyle = t0 < position ? played : ahead;
        g.fillRect(i * bar, mid - h / 2, bar - dpr, h);
      }
      const x = (position / span) * width;
      if (position > 0) {
        g.fillStyle = played;
        g.fillRect(Math.min(width - dpr, x), 0, dpr, height);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!abortRef.current) perform();
      } else if (event.key === "Escape" && (abortRef.current || liveRef.current?.active)) {
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [perform, stop]);

  useEffect(() => () => { takesRef.current.forEach((take) => URL.revokeObjectURL(take.url)); }, []);

  /* ---------- script editing ---------- */

  const updateLine = (id, patch) => setScene((s) => ({ ...s, lines: s.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
  const removeLine = (id) => {
    const index = scene.lines.findIndex((l) => l.id === id);
    const rest = scene.lines.filter((l) => l.id !== id);
    setScene((s) => ({ ...s, lines: s.lines.filter((l) => l.id !== id) }));
    if (rest.length) setFocusId(rest[Math.max(0, index - 1)].id);
  };
  const moveLine = (id, delta) => setScene((s) => {
    const lines = [...s.lines];
    const index = lines.findIndex((l) => l.id === id);
    const target = index + delta;
    if (target < 0 || target >= lines.length) return s;
    [lines[index], lines[target]] = [lines[target], lines[index]];
    return { ...s, lines };
  });
  const insertAfter = (id) => {
    if (scene.lines.length >= MAX_LINES) return;
    const createdId = newId();
    setScene((s) => {
      const index = id ? s.lines.findIndex((l) => l.id === id) : s.lines.length - 1;
      const previous = s.lines[index];
      const role = previous ? (previous.role + 1) % s.cast.length : 0;
      const lines = [...s.lines];
      lines.splice(index + 1, 0, { id: createdId, role, text: "", emotion: "neutral" });
      return { ...s, lines };
    });
    setFocusId(createdId);
  };
  const renameCast = (index, name) => setScene((s) => ({ ...s, cast: s.cast.map((c, i) => (i === index ? { ...c, name } : c)) }));
  const loadPreset = (id) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) setScene(sceneFromPreset(preset));
  };
  const acceptWritten = (written) => {
    setScene((s) => ({
      ...s, presetId: null, title: written.title || s.title, cast: written.cast, lines: written.lines,
      backdrop: written.backdrop || null,
    }));
    setNotice({
      tone: written.warnings.length ? "warn" : "ok",
      text: `Scene written by ${written.model}. Edit the script, then click Generate conversation.${written.warnings.length ? " " + written.warnings.join(" ") : ""}`,
    });
  };
  const importScript = (text) => {
    const parsed = parseScript(text);
    setScene((s) => ({ ...s, presetId: null, cast: parsed.cast, lines: parsed.lines }));
    setNotice(parsed.warnings.length ? { tone: "warn", text: parsed.warnings.join(" ") } : { tone: "ok", text: `Imported ${parsed.lines.length} lines.` });
  };

  /* ---------- derived display ---------- */

  const editedSince = selectedTake && !selectedTake.recorded && selectedTake.key !== currentKey;
  const telemetry = (() => {
    const source = generating ? run : selectedTake && !selectedTake.recorded
      ? { firstAudioMs: selectedTake.firstAudioMs, received: selectedTake.duration, renderMs: selectedTake.renderMs }
      : null;
    if (!source) return { first: "—", audio: "—", speed: "—" };
    const elapsed = generating ? (performance.now() - (liveRef.current?.startedAt ?? performance.now())) : source.renderMs;
    const audio = source.received ?? 0;
    return {
      first: source.firstAudioMs != null ? fmtLatency(source.firstAudioMs) : "…",
      audio: audio ? `${audio.toFixed(1)} s` : "…",
      speed: audio && elapsed ? `${(audio / (elapsed / 1000)).toFixed(1)}×` : "…",
    };
  })();
  const fastestId = takes.filter((t) => !t.recorded && t.firstAudioMs != null)
    .reduce((best, t) => (!best || t.firstAudioMs < best.firstAudioMs ? t : best), null)?.id;
  const status = statusLine({ run, health, problems, apiUrl, selectedTake, editedSince });

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">Drama Studio</span>
          <span className="tri" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <div className="topbar-right">
          <ServerBadge health={health} backend={backend} onClick={() => setSettingsOpen((o) => !o)} />
          <button type="button" className="icon-button" aria-label="Server settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
            <GearIcon />
          </button>
          {settingsOpen && (
            <ServerSettings
              apiUrl={apiUrl}
              onSave={(value) => { const clean = value.trim().replace(/\/$/, "") || DEFAULT_API; setApiUrl(clean); storage.set(STORAGE_KEY, clean === DEFAULT_API ? "" : clean); setSettingsOpen(false); }}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      </header>

      <p className="inference-note">Voices generated on a MacBook with our custom C++/MLX inference implementation, integrated with SGLang-Omni.</p>

      <main className="layout">
        <section className="script-pane" aria-label="Script">
          <div className="scene-head">
            <input
              className="scene-title"
              value={scene.title}
              onChange={(e) => setScene((s) => ({ ...s, title: e.target.value }))}
              aria-label="Scene title"
              placeholder="Untitled scene"
            />
            <div className="scene-tools">
              <label className="preset-select">
                <span className="preset-label">Choose a script</span>
                <select value={scene.presetId || ""} onChange={(e) => loadPreset(e.target.value)}>
                  <option value="" disabled>Sample scenes…</option>
                  {PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>{preset.title} — {preset.note}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="ghost-button" onClick={() => setPasteOpen(true)}>
                <PasteIcon /> Paste script
              </button>
            </div>
          </div>

          <div className="cast">
            <h2 className="pane-label">Cast</h2>
            <ul className="cast-list">
              {scene.cast.map((member, index) => (
                <li key={index} className="cast-member" style={{ "--role": CAST_COLORS[index] }}>
                  <span className="cast-mark" aria-hidden="true">{(member.name || "?").slice(0, 1)}</span>
                  <input
                    value={member.name}
                    onChange={(e) => renameCast(index, e.target.value)}
                    aria-label={`Name of voice ${index + 1}`}
                    maxLength={24}
                  />
                  <span className="cast-voice">Voice {index + 1}</span>
                </li>
              ))}
            </ul>
            <p className="fine-print">
              {MAX_CAST} voices per scene. Drama3 picks each voice fresh every take, so a character can sound different between takes.
            </p>
          </div>

          <ol className="lines">
            {scene.lines.map((item, index) => (
              <LineRow
                key={item.id}
                item={item}
                index={index}
                total={scene.lines.length}
                cast={scene.cast}
                focus={focusId === item.id}
                onFocused={() => setFocusId(null)}
                onChange={(patch) => updateLine(item.id, patch)}
                onRemove={() => removeLine(item.id)}
                onMove={(delta) => moveLine(item.id, delta)}
                onEnter={() => insertAfter(item.id)}
                onPerform={perform}
              />
            ))}
          </ol>
          <div className="lines-foot">
            <button type="button" className="add-line" onClick={() => insertAfter(null)} disabled={scene.lines.length >= MAX_LINES}>
              <PlusIcon /> Add line
            </button>
            <span className="count">{scene.lines.length} of {MAX_LINES} lines · Enter adds the next line</span>
          </div>
        </section>

        <aside className="stage-pane" aria-label="Stage">
          <div
            ref={stageRef}
            className={`stage phase-${run.phase} ${generating ? "is-live" : ""} ${isMock ? "is-mock" : ""}`}
          >
            <div className="cockpit">
              {scene.backdrop && <div className="set" style={{ backgroundImage: `url(${scene.backdrop})` }} aria-hidden="true" />}
              <svg className="stage-art" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                {[40, 140, 240, 340, 440].map((a, i) => (
                  <polygon key={a} points={`${a},-20 ${a + 46},-20 ${a - 74},130 ${a + 46},280 ${a},280 ${a - 120},130`} className={i % 2 ? "band-b" : "band-a"} />
                ))}
              </svg>
              <div className="start-lights" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className="light" style={{ "--i": i }}><i /><i /></span>
                ))}
              </div>
              <canvas
                ref={canvasRef}
                className="wave"
                onClick={seek}
                role="img"
                aria-label={selectedTake ? `Waveform of ${selectedTake.label}` : "Waveform"}
              />
              <div className="players">
                {scene.cast.map((member, index) => (
                  <span key={index} className="player" style={{ "--role": CAST_COLORS[index] }}>
                    <b>{index + 1}</b>{member.name || `Voice ${index + 1}`}
                  </span>
                ))}
              </div>
              {isMock && <p className="mock-ribbon">Mock server: plays a fixed sample, not your script</p>}
              {!generating && !takes.length && run.phase !== "error" && health.status === "offline" && (
                <div className="stage-empty">
                  <p>The voice server isn't reachable from this page.</p>
                  <button type="button" className="ghost-button" onClick={loadRecordedTake}>
                    <PlayIcon /> Play sample conversation
                  </button>
                </div>
              )}
            </div>
            <dl className="telemetry">
              <div><dt>First audio</dt><dd>{telemetry.first}</dd></div>
              <div><dt>Audio</dt><dd>{telemetry.audio}</dd></div>
              <div><dt>Speed</dt><dd>{telemetry.speed}</dd></div>
            </dl>
          </div>

          <div className="controls">
            {generating ? (
              <button type="button" className="perform is-stop" onClick={stop}>
                <StopIcon /> Cancel generation
              </button>
            ) : (
              <button
                type="button"
                className="perform"
                onClick={perform}
                disabled={problems.length > 0}
                title="Generate and play a new conversation (⌘ Enter)"
              >
                <PlayIcon /> Generate conversation
              </button>
            )}
            <p className="generation-guidance">We recommend two short lines for live generation. Longer conversations may contain silence or stop early due to bugs in our inference code.</p>
            {nowPlaying === "stream" && !generating && (
              <button type="button" className="transport" onClick={stop}><StopIcon /> Stop playback</button>
            )}
            {selectedTake && !generating && nowPlaying !== "stream" && (
              <button type="button" className="transport" onClick={() => toggleTake(selectedTake)} aria-label={nowPlaying === selectedTake.id ? "Pause conversation" : `Play ${selectedTake.label}`}>
                {nowPlaying === selectedTake.id ? <PauseIcon /> : <PlayIcon />}
                {nowPlaying === selectedTake.id ? "Pause conversation" : "Play conversation"}
              </button>
            )}
            {selectedTake && !generating && (
              <a className="transport" href={selectedTake.url} download={downloadName(scene.title, selectedTake)}>
                <DownloadIcon /> Download audio
              </a>
            )}
          </div>

          <p className={`status status-${status.tone}`} role="status" aria-live="polite">{status.text}</p>
          {notice && (
            <p className={`notice notice-${notice.tone}`}>
              {notice.text}
              <button type="button" className="icon-button small" aria-label="Dismiss" onClick={() => setNotice(null)}><CloseIcon /></button>
            </p>
          )}

          {takes.length > 0 && (
            <div className="takes">
              <div className="takes-heading">
                <h2 className="pane-label">Generated conversations</h2>
                <div className="takes-invitation">
                  <span>Try these voices</span>
                  <small>Generated on a MacBook</small>
                  <svg viewBox="0 0 220 64" aria-hidden="true">
                    <path d="M205 8 C167 0 148 23 163 31 C183 43 196 12 174 14 C139 17 115 53 15 49 M29 38 L14 49 L29 59" />
                  </svg>
                </div>
              </div>
              <ol>
                {[...takes].sort((a, b) => {
                  const priority = (take) => take.id === "saved-box-original" ? 0
                    : take.id === "saved-box-edited" ? 1
                    : 2;
                  return priority(a) - priority(b);
                }).map((take) => (
                  <li key={take.id} className={`take ${take.id === selectedId ? "is-selected" : ""} ${take.id === fastestId && takes.length > 1 ? "is-fastest" : ""}`}>
                    <span className="take-pos">{take.recorded ? "R" : take.number}</span>
                    <button type="button" className="take-play" onClick={() => toggleTake(take)} aria-label={nowPlaying === take.id ? `Pause ${take.label}` : `Play ${take.label}`}>
                      {nowPlaying === take.id ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <button type="button" className="take-main" onClick={() => setSelectedId(take.id)}>
                      <span className="take-time">{take.recorded ? `${take.label} · ` : ""}{fmtLap(take.duration)}</span>
                      <span className="take-meta">
                        {take.firstAudioMs != null ? `first audio ${fmtLatency(take.firstAudioMs)}` : "recorded earlier on Drama3"}
                        {take.key === currentKey && !take.recorded ? " · current script" : ""}
                      </span>
                    </button>
                    {take.id === fastestId && takes.length > 1 && <span className="tag tag-fastest" title="Fastest time to first audio">Fastest</span>}
                    <span className={`tag tag-${take.backend}`}>{take.backend === "mlx" ? "Live" : take.backend === "mock" ? "Mock" : "Recorded"}</span>
                    {take.truncated && <span className="tag tag-warn" title="A segment hit the model's length limit; the take may be cut short.">Cut short</span>}
                    <a className="icon-button" href={take.url} download={downloadName(scene.title, take)} aria-label={`Download ${take.label}`}>
                      <DownloadIcon />
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </aside>
      </main>

      {writeOpen && (
        <WriteDialog
          onClose={() => setWriteOpen(false)}
          onWritten={(written) => { acceptWritten(written); setWriteOpen(false); }}
        />
      )}

      {pasteOpen && (
        <PasteDialog
          initial={toPlainScript(scene)}
          onClose={() => setPasteOpen(false)}
          onImport={(text) => { importScript(text); setPasteOpen(false); }}
        />
      )}

      {/* Replay transport; routed through the AudioContext so the stage light follows it. */}
      <audio
        ref={audioElRef}
        preload="auto"
        onEnded={() => setNowPlaying(null)}
        onPause={() => setNowPlaying((current) => (current && current !== "stream" ? null : current))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Running peak envelope across chunk boundaries, so the live waveform stays in time. */
function pushPeaks(live, samples, step) {
  let { carryMax, carryCount } = live;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > carryMax) carryMax = value;
    if (++carryCount === step) { live.peaks.push(carryMax / 32768); carryMax = 0; carryCount = 0; }
  }
  live.carryMax = carryMax;
  live.carryCount = carryCount;
}

function statusLine({ run, health, problems, apiUrl, selectedTake, editedSince }) {
  switch (run.phase) {
    case "connecting":
      return { tone: "live", text: run.waiting ? "Waiting for the previous generation to finish…" : "Generating conversation. Waiting for the first audio…" };
    case "streaming":
      return {
        tone: "live",
        text: `Generating and playing. First audio after ${fmtLatency(run.firstAudioMs)}, ${fmtSec(run.received)} received so far.`,
      };
    case "cancelled":
      return { tone: "quiet", text: "Generation cancelled. No audio was saved." };
    case "error":
      return { tone: "error", text: run.message };
    case "done":
      if (editedSince) return { tone: "quiet", text: `${selectedTake.label} is from an earlier version of the script. Click Generate conversation to hear your edits.` };
      return {
        tone: run.truncated ? "warn" : "ok",
        text: run.truncated
          ? `Finished, but a segment hit the model's length limit and may be cut short. Try shorter lines.`
          : `Generated: ${fmtSec(run.duration)} of audio, rendered in ${fmtSec(run.renderMs / 1000)}.`,
      };
    default:
      break;
  }
  if (problems.length) return { tone: "warn", text: problems[0] };
  if (editedSince) return { tone: "quiet", text: `${selectedTake.label} is from an earlier version of the script. Click Generate conversation to hear your edits.` };
  if (selectedTake?.recorded) return { tone: "quiet", text: "This saved recording was generated earlier on a MacBook. Edit the script and generate a new take to hear your changes." };
  if (health.status === "offline") return { tone: "error", text: `Can't reach the voice server at ${apiUrl}. Start it, or change the address in Server settings.` };
  if (health.status === "checking") return { tone: "quiet", text: "Looking for the voice server…" };
  return { tone: "quiet", text: "Ready. Click Generate conversation or press ⌘ Enter to generate and play audio." };
}

function downloadName(title, take) {
  const slug = (title || "scene").trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "scene";
  return `${slug}-${take.recorded ? "recorded" : `conversation-${take.number}`}.wav`;
}

function ServerBadge({ health, backend, onClick }) {
  let tone = "off";
  let text = "Voice server offline";
  if (health.status === "checking") { tone = "pending"; text = "Connecting…"; }
  else if (health.status === "starting") { tone = "pending"; text = "Server starting"; }
  else if (health.status === "online") {
    if (backend === "mock") { tone = "mock"; text = "Mock server"; }
    else { tone = "live"; text = "Live · Drama3 On Lennox's Macbook MLX"; }
    if (health.busy) text += " · busy";
  }
  return (
    <button type="button" className={`server-badge badge-${tone}`} onClick={onClick}>
      <span className="dot" aria-hidden="true" />
      {text}
    </button>
  );
}

function ServerSettings({ apiUrl, onSave, onClose }) {
  const [value, setValue] = useState(apiUrl);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const localPage = /^https?:\/\/(localhost|127\.0\.0\.1):3000$/.test(origin);
  return (
    <form className="settings" onSubmit={(e) => { e.preventDefault(); onSave(value); }}>
      <label htmlFor="api-url">Voice server address</label>
      <input id="api-url" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoFocus />
      <p className="fine-print">
        The page calls this server directly from your browser. Default: {DEFAULT_API}.
        {!localPage && <> This page runs at <code>{origin}</code>, so start the server with <code>DRAMA_ALLOWED_ORIGINS={origin}</code>. If Chrome asks to let this site reach devices on your local network, allow it.</>}
      </p>
      <div className="settings-actions">
        <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
        <button type="submit" className="solid-button">Connect</button>
      </div>
    </form>
  );
}

function LineRow({ item, index, total, cast, focus, onFocused, onChange, onRemove, onMove, onEnter, onPerform }) {
  const textRef = useRef(null);
  const color = CAST_COLORS[item.role] || CAST_COLORS[0];

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [item.text]);

  useEffect(() => {
    if (focus && textRef.current) {
      const el = textRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      onFocused();
    }
  }, [focus, onFocused]);

  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return; // IME (e.g. Pinyin) in progress
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return; // handled globally
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onEnter();
    } else if (event.key === "Backspace" && !item.text && total > 1) {
      event.preventDefault();
      onRemove();
    }
  };

  const length = item.text.trim().length;
  return (
    <li className="line" style={{ "--role": color }}>
      <span className="line-number" aria-hidden="true">{index + 1}</span>
      <div className="line-body">
        <div className="line-head">
          <div className="who" role="radiogroup" aria-label={`Speaker for line ${index + 1}`}>
            {cast.map((member, role) => (
              <button
                key={role}
                type="button"
                role="radio"
                aria-checked={item.role === role}
                className={`who-option ${item.role === role ? "is-on" : ""}`}
                style={{ "--role": CAST_COLORS[role] }}
                onClick={() => onChange({ role })}
              >
                {member.name || `Voice ${role + 1}`}
              </button>
            ))}
          </div>
          <div className="direction" role="radiogroup" aria-label={`Delivery for line ${index + 1}`}>
            {EMOTIONS.map((emotion) => (
              <button
                key={emotion.id}
                type="button"
                role="radio"
                aria-checked={item.emotion === emotion.id}
                className={`direction-option ${item.emotion === emotion.id ? "is-on" : ""}`}
                onClick={() => onChange({ emotion: emotion.id })}
              >
                ({emotion.label.toLowerCase()})
              </button>
            ))}
          </div>
        </div>
        <textarea
          ref={textRef}
          rows={1}
          value={item.text}
          maxLength={MAX_CHARS + 50}
          placeholder="Write the line…"
          aria-label={`Line ${index + 1} text`}
          onChange={(e) => onChange({ text: e.target.value.replace(/\n/g, " ") })}
          onKeyDown={onKeyDown}
        />
        {length > MAX_CHARS - 60 && (
          <span className={`char-count ${length > MAX_CHARS ? "is-over" : ""}`}>{length} / {MAX_CHARS}</span>
        )}
      </div>
      <div className="line-tools">
        <button type="button" className="icon-button small" aria-label="Move line up" disabled={index === 0} onClick={() => onMove(-1)}><UpIcon /></button>
        <button type="button" className="icon-button small" aria-label="Move line down" disabled={index === total - 1} onClick={() => onMove(1)}><DownIcon /></button>
        <button type="button" className="icon-button small" aria-label="Delete line" disabled={total <= 1} onClick={onRemove}><CloseIcon /></button>
      </div>
    </li>
  );
}

function PasteDialog({ initial, onClose, onImport }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const submit = (event) => {
    event.preventDefault();
    try {
      parseScript(text);
      onImport(text);
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <dialog ref={ref} className="paste" onClose={onClose} onCancel={onClose}>
      <form onSubmit={submit}>
        <h2>Paste a script</h2>
        <p className="fine-print">
          One line per row as <code>Name: what they say</code>. Add a stage direction after the colon to set the delivery:
          <code>(anxious)</code> <code>(laughs)</code> <code>(whispers)</code> <code>(sighs)</code>.
          The first {MAX_CAST} names become the cast; up to {MAX_LINES} lines.
        </p>
        <p className="fine-print">Try two short lines first. Copy this format, then edit the dialogue:</p>
        <pre style={{ whiteSpace: "pre-wrap" }}>{"Alex: Please tell me you got it.\nSam: Yes, but we should leave now."}</pre>
        <button type="button" className="ghost-button" onClick={() => { setText("Alex: Please tell me you got it.\nSam: Yes, but we should leave now."); setError(null); }}>Use example</button>
        <textarea aria-label="Script text" value={text} onChange={(e) => { setText(e.target.value); setError(null); }} rows={10} spellCheck={false} autoFocus />
        {error && <p className="notice notice-error">{error}</p>}
        <div className="settings-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="solid-button">Replace script</button>
        </div>
      </form>
    </dialog>
  );
}

function WriteDialog({ onClose, onWritten }) {
  const [idea, setIdea] = useState("");
  const [image, setImage] = useState(null);
  const language = "en";
  const [state, setState] = useState({ phase: "checking" });
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    let cancelled = false;
    fetch("/api/write-scene", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((info) => { if (!cancelled) setState(info.enabled ? { phase: "ready", model: info.model } : { phase: "disabled" }); })
      .catch(() => { if (!cancelled) setState({ phase: "disabled" }); });
    return () => { cancelled = true; };
  }, []);

  const takeFile = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      setImage(await imageToDataUrl(file));
      setState((s) => (s.phase === "error" ? { phase: "ready", model: s.model } : s));
    } catch (e) {
      setState((s) => ({ ...s, phase: "error", message: e.message }));
    }
  };

  const onPaste = (event) => {
    const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
    if (file) { event.preventDefault(); takeFile(file); }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!idea.trim() && !image) return;
    const model = state.model;
    setState({ phase: "writing", model });
    try {
      const response = await fetch("/api/write-scene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, image, language }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `The writer answered HTTP ${response.status}.`);
      const written = parseWrittenScene(body.text);
      onWritten({ ...written, backdrop: image, model: body.model || model });
    } catch (e) {
      setState({ phase: "error", model, message: e.message });
    }
  };

  const busy = state.phase === "writing";
  return (
    <dialog ref={ref} className="paste write" onClose={onClose} onCancel={onClose} onPaste={onPaste}>
      <form onSubmit={submit}>
        <h2>Write a scene with AI</h2>
        <p className="fine-print">
          Give it a picture, an idea, or both. A vision model writes a two-voice scene with stage directions; Drama3 then performs it on this Mac.
        </p>
        <div
          className={`drop ${dragging ? "is-over" : ""} ${image ? "has-image" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); takeFile(e.dataTransfer.files?.[0]); }}
        >
          {image ? (
            <>
              <img src={image} alt="Picture the scene will be written from" />
              <button type="button" className="ghost-button" onClick={() => setImage(null)}><CloseIcon /> Remove picture</button>
            </>
          ) : (
            <button type="button" className="drop-pick" onClick={() => fileRef.current?.click()}>
              <ImageIcon />
              <span>Drop a picture, paste one, or <u>choose a file</u></span>
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => takeFile(e.target.files?.[0])} />
        </div>
        <label className="write-label" htmlFor="write-idea">What happens? <span>(optional with a picture)</span></label>
        <textarea
          id="write-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder="A race engineer talks a rookie driver through the last lap while the tyres fall apart."
        />
        <div className="write-row">
          <span className="fine-print write-model">{state.model ? `Model: ${state.model}` : ""}</span>
        </div>
        {state.phase === "disabled" && (
          <p className="notice notice-warn">The writer isn't set up on this deployment. Add <code>AI_GATEWAY_API_KEY</code> to the environment and restart.</p>
        )}
        {state.phase === "error" && <p className="notice notice-error">{state.message}</p>}
        <div className="settings-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="solid-button" disabled={busy || state.phase === "disabled" || state.phase === "checking" || (!idea.trim() && !image)}>
            {busy ? "Writing…" : "Write scene"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
