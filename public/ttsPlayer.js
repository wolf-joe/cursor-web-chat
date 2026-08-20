// 决策·seek-after-cache: 首播流式 pcm 用 Web Audio(仅播/暂停);
// 缓存命中后 GET wav + <audio> 可拖动。总时长在拿到 wav metadata 后展示。
// 决策·wake-lock-lifecycle: Screen Wake Lock 跟播放态走,无 API/拒绝则静默降级。
// 决策·tts-mini-bar: 朗读会话(loading/streaming/cached,含暂停)在模型条上方出停/暂停;
// 自然播完与停止收起; Overlay 打开时条抬到其上方。
import { state } from "./state.js";
import { ttsAudioUrl } from "./api.js";
import {
  ttsMiniBar,
  ttsMiniStopBtn,
  ttsMiniPlayBtn,
  ttsMiniStatus,
  diffOverlay,
  fileBrowserOverlay,
} from "./dom.js";

const SAMPLE_RATE = 24000;

const player = {
  runId: null,
  mode: "idle", // idle | loading | streaming | cached | error
  phase: "",
  error: null,
  audio: null,
  ctx: null,
  nextTime: 0,
  paused: false,
  abort: null,
  drainTimer: null,
  controls: new Map(),
  /** @type {Map<string, number>} runId → 秒 */
  durations: new Map(),
  /** @type {WakeLockSentinel | null} */
  wakeLock: null,
};

function isActivelyPlaying() {
  if (!player.runId) return false;
  if (player.mode === "loading" || player.mode === "streaming") return !player.paused;
  if (player.mode === "cached" && player.audio) return !player.audio.paused;
  return false;
}

/** 迷你条显隐:点了朗读且尚未 idle/error(含口语化与暂停)。 */
export function isTtsSessionActive() {
  if (!player.runId) return false;
  return player.mode === "loading" || player.mode === "streaming" || player.mode === "cached";
}

function overlayOpen() {
  return (
    (diffOverlay && diffOverlay.classList.contains("open")) ||
    (fileBrowserOverlay && fileBrowserOverlay.classList.contains("open"))
  );
}

function syncMiniBar() {
  if (!ttsMiniBar) return;
  const active = isTtsSessionActive();
  ttsMiniBar.hidden = !active;
  ttsMiniBar.classList.toggle("over-overlay", active && overlayOpen());
  if (!active) {
    if (ttsMiniStatus) ttsMiniStatus.textContent = "";
    return;
  }
  if (ttsMiniPlayBtn) {
    if (player.mode === "loading") {
      ttsMiniPlayBtn.textContent = "…";
      ttsMiniPlayBtn.disabled = true;
    } else {
      ttsMiniPlayBtn.disabled = false;
      const paused =
        player.mode === "streaming"
          ? player.paused
          : !!(player.audio && player.audio.paused);
      ttsMiniPlayBtn.textContent = paused ? "▶" : "❚❚";
    }
  }
  if (ttsMiniStatus) {
    if (player.mode === "loading") {
      ttsMiniStatus.textContent = player.phase === "rewriting" ? "口语化…" : "准备中…";
    } else if (player.mode === "streaming") {
      ttsMiniStatus.textContent = player.paused ? "已暂停" : "朗读中…";
    } else {
      ttsMiniStatus.textContent = player.audio && player.audio.paused ? "已暂停" : "朗读中…";
    }
  }
}

/** 按设置与播放态申请/释放 Wake Lock(决策·wake-lock-lifecycle)。 */
export function syncWakeLock() {
  const want =
    state.userSettings.keepAwakeWhileTts &&
    isActivelyPlaying() &&
    typeof navigator !== "undefined" &&
    "wakeLock" in navigator &&
    document.visibilityState === "visible";

  if (!want) {
    if (player.wakeLock) {
      player.wakeLock.release().catch(() => {});
      player.wakeLock = null;
    }
    return;
  }
  if (player.wakeLock && !player.wakeLock.released) return;
  navigator.wakeLock
    .request("screen")
    .then((sentinel) => {
      // 申请返回前状态可能已变(关掉开关 / 已停播)。
      if (!state.userSettings.keepAwakeWhileTts || !isActivelyPlaying()) {
        sentinel.release().catch(() => {});
        return;
      }
      player.wakeLock = sentinel;
      sentinel.addEventListener("release", () => {
        if (player.wakeLock === sentinel) player.wakeLock = null;
      });
    })
    .catch(() => {
      // 决策·wake-lock-lifecycle: 拒绝/不支持静默降级,不 toast。
    });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncWakeLock();
});

function getCtx() {
  if (!player.ctx) player.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  return player.ctx;
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "–:––";
  const s = Math.floor(sec + 0.0001);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function setStatus(runId, text) {
  const root = player.controls.get(runId);
  if (!root) return;
  const status = root.querySelector(".tts-status");
  if (status) status.textContent = text || "";
}

function setButtonLabel(runId, label) {
  const root = player.controls.get(runId);
  if (!root) return;
  const btn = root.querySelector(".tts-play-btn");
  if (btn) btn.textContent = label;
}

function setSeekEnabled(runId, enabled, max = 0, value = 0) {
  const root = player.controls.get(runId);
  if (!root) return;
  const seek = root.querySelector(".tts-seek");
  if (!seek) return;
  seek.disabled = !enabled;
  if (enabled) {
    seek.max = String(max || 0);
    seek.value = String(value || 0);
  } else {
    seek.max = "0";
    seek.value = "0";
  }
}

/** 有总时长时展示；播放中带当前进度。 */
function setTimeDisplay(runId, current, total) {
  const root = player.controls.get(runId);
  if (!root) return;
  const el = root.querySelector(".tts-time");
  if (!el) return;
  if (total != null && Number.isFinite(total) && total > 0) {
    el.hidden = false;
    if (current != null && Number.isFinite(current)) {
      el.textContent = `${formatTime(current)} / ${formatTime(total)}`;
    } else {
      el.textContent = formatTime(total);
    }
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function rememberDuration(runId, sec) {
  if (!Number.isFinite(sec) || sec <= 0) return;
  player.durations.set(runId, sec);
}

function syncControl(runId) {
  const known = player.durations.get(runId);
  if (player.runId !== runId) {
    setButtonLabel(runId, "▶");
    setSeekEnabled(runId, false);
    setStatus(runId, "");
    setTimeDisplay(runId, null, known);
    syncMiniBar();
    return;
  }
  if (player.mode === "loading") {
    setButtonLabel(runId, "…");
    setSeekEnabled(runId, false);
    setStatus(runId, player.phase === "rewriting" ? "口语化…" : "准备中…");
    setTimeDisplay(runId, null, null);
  } else if (player.mode === "streaming") {
    setButtonLabel(runId, player.paused ? "▶" : "❚❚");
    setSeekEnabled(runId, false);
    setStatus(runId, player.paused ? "已暂停" : "朗读中…");
    // 流式总时长未知,不硬编假进度。
    setTimeDisplay(runId, null, null);
  } else if (player.mode === "cached") {
    const playing = player.audio && !player.audio.paused;
    setButtonLabel(runId, playing ? "❚❚" : "▶");
    const audio = player.audio;
    const total =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : known;
    if (audio && total) {
      setSeekEnabled(runId, true, total, audio.currentTime || 0);
      setTimeDisplay(runId, audio.currentTime || 0, total);
    } else {
      setSeekEnabled(runId, false);
      setTimeDisplay(runId, null, known);
    }
    setStatus(runId, "");
  } else if (player.mode === "error") {
    setButtonLabel(runId, "▶");
    setSeekEnabled(runId, false);
    setStatus(runId, player.error || "失败，点击重试");
    setTimeDisplay(runId, null, known);
  } else {
    setButtonLabel(runId, "▶");
    setSeekEnabled(runId, false);
    setStatus(runId, "");
    setTimeDisplay(runId, null, known);
  }
  syncMiniBar();
}

function clearDrainTimer() {
  if (player.drainTimer) {
    clearTimeout(player.drainTimer);
    player.drainTimer = null;
  }
}

function stopAll() {
  clearDrainTimer();
  if (player.abort) {
    player.abort.abort();
    player.abort = null;
  }
  if (player.audio) {
    player.audio.pause();
    player.audio.removeAttribute("src");
    player.audio.load();
    player.audio = null;
  }
  if (player.ctx) {
    try {
      player.ctx.close();
    } catch {
      // ignore
    }
    player.ctx = null;
  }
  const prev = player.runId;
  player.runId = null;
  player.mode = "idle";
  player.phase = "";
  player.error = null;
  player.nextTime = 0;
  player.paused = false;
  syncWakeLock();
  if (prev) syncControl(prev);
  else syncMiniBar();
}

/** 静默读 wav metadata,拿到总时长后写到控件上(不播放)。 */
function probeDuration(runId) {
  if (player.durations.has(runId)) {
    setTimeDisplay(runId, null, player.durations.get(runId));
    return;
  }
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = ttsAudioUrl(runId);
  audio.addEventListener(
    "loadedmetadata",
    () => {
      rememberDuration(runId, audio.duration);
      // 仅刷新时长展示,不改按钮态(可能正在播别的 run)。
      if (player.runId !== runId || player.mode === "idle" || player.mode === "error") {
        setTimeDisplay(runId, null, audio.duration);
      } else {
        syncControl(runId);
      }
    },
    { once: true },
  );
  audio.addEventListener(
    "error",
    () => {
      // 无缓存或尚未生成——保持隐藏即可
    },
    { once: true },
  );
}

function schedulePcmChunk(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // 拷贝到对齐的 buffer,避免 base64 长度非 2 对齐时 Int16Array 抛错。
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  const samples = new Int16Array(aligned);
  const ctx = getCtx();
  const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime, player.nextTime);
  source.start(startAt);
  player.nextTime = startAt + buffer.duration;
}

async function playCached(runId) {
  const audio = new Audio(ttsAudioUrl(runId));
  player.audio = audio;
  player.mode = "cached";
  player.paused = false;
  syncWakeLock();
  audio.addEventListener("loadedmetadata", () => {
    rememberDuration(runId, audio.duration);
    syncControl(runId);
  });
  audio.addEventListener("timeupdate", () => {
    if (player.runId !== runId || player.mode !== "cached") return;
    const total = audio.duration;
    if (Number.isFinite(total) && total > 0) {
      setSeekEnabled(runId, true, total, audio.currentTime);
      setTimeDisplay(runId, audio.currentTime, total);
    }
  });
  audio.addEventListener("ended", () => {
    if (player.runId !== runId) return;
    finishCachedToIdle(runId);
  });
  audio.addEventListener("error", () => {
    if (player.runId !== runId) return;
    player.mode = "error";
    player.error = "播放失败";
    syncWakeLock();
    syncControl(runId);
  });
  await audio.play();
  syncWakeLock();
  syncControl(runId);
}

function finishCachedToIdle(runId) {
  if (player.audio) {
    player.audio.pause();
    player.audio.removeAttribute("src");
    player.audio.load();
    player.audio = null;
  }
  if (player.runId !== runId) return;
  player.mode = "idle";
  player.paused = false;
  syncWakeLock();
  syncControl(runId);
}

function finishStreamingToIdle(runId) {
  clearDrainTimer();
  if (player.ctx) {
    try {
      player.ctx.close();
    } catch {
      // ignore
    }
    player.ctx = null;
  }
  if (player.runId !== runId) return;
  player.mode = "idle";
  player.paused = false;
  player.nextTime = 0;
  syncWakeLock();
  syncControl(runId);
  // 首播落盘后补读总时长。
  probeDuration(runId);
}

async function startStream(runId) {
  const cwd = state.currentCwd;
  const agentId = state.currentAgentId;
  if (!cwd || !agentId) {
    player.mode = "error";
    player.error = "无当前会话";
    syncWakeLock();
    syncControl(runId);
    return;
  }

  player.mode = "loading";
  player.phase = "rewriting";
  player.error = null;
  player.paused = false;
  player.nextTime = 0;
  syncWakeLock();
  syncControl(runId);

  const abort = new AbortController();
  player.abort = abort;

  const res = await fetch("/api/tts/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, agentId, runId }),
    signal: abort.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`TTS 请求失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (event.type === "status") {
        player.phase = event.phase;
        if (event.phase === "synthesizing") {
          player.mode = "streaming";
          const ctx = getCtx();
          if (ctx.state === "suspended") await ctx.resume();
          player.nextTime = ctx.currentTime;
          syncWakeLock();
        }
        syncControl(runId);
      } else if (event.type === "audio" && event.data) {
        // 决策·play-on-first-pcm: 首个 audio chunk 即开播（不必等整句 TTS 结束）。
        // 若 synthesizing 状态尚未到达，也在此 resume AudioContext。
        if (player.mode !== "streaming") {
          player.mode = "streaming";
          const ctx = getCtx();
          if (ctx.state === "suspended") await ctx.resume();
          if (!player.nextTime) player.nextTime = ctx.currentTime;
          syncWakeLock();
        }
        // 暂停靠 AudioContext.suspend,块仍排程,恢复后继续播。
        schedulePcmChunk(event.data);
        syncControl(runId);
      } else if (event.type === "done") {
        player.abort = null;
        const ctx = player.ctx;
        if (ctx) {
          const remainingMs = Math.max(0, (player.nextTime - ctx.currentTime) * 1000) + 80;
          player.drainTimer = setTimeout(() => finishStreamingToIdle(runId), remainingMs);
        } else {
          finishStreamingToIdle(runId);
        }
        syncControl(runId);
        return;
      } else if (event.type === "error") {
        throw new Error(event.message || "TTS 失败");
      }
    }
  }

  // 流意外结束(无 done/error):常见于旧 bug 把响应提前关掉;若已落盘则改走缓存。
  player.abort = null;
  const probe = await fetch(ttsAudioUrl(runId), { method: "HEAD" });
  if (probe.ok) {
    await playCached(runId);
    return;
  }
  throw new Error("TTS 流中断且无缓存");
}

async function startPlay(runId) {
  stopAll();
  player.runId = runId;
  player.mode = "loading";
  player.phase = "";
  player.error = null;
  player.paused = false;
  syncWakeLock();
  syncControl(runId);

  const probe = await fetch(ttsAudioUrl(runId), { method: "HEAD" });
  if (probe.ok) {
    await playCached(runId);
    return;
  }

  try {
    await startStream(runId);
  } catch (err) {
    if (err?.name === "AbortError") return;
    player.mode = "error";
    player.error = err instanceof Error ? err.message : String(err);
    syncWakeLock();
    syncControl(runId);
  }
}

async function togglePlay(runId) {
  if (player.runId === runId) {
    if (player.mode === "streaming") {
      const ctx = getCtx();
      if (player.paused) {
        player.paused = false;
        await ctx.resume();
      } else {
        player.paused = true;
        await ctx.suspend();
      }
      syncWakeLock();
      syncControl(runId);
      return;
    }
    if (player.mode === "cached" && player.audio) {
      if (player.audio.paused) {
        await player.audio.play();
        player.paused = false;
      } else {
        player.audio.pause();
        player.paused = true;
      }
      syncWakeLock();
      syncControl(runId);
      return;
    }
    if (player.mode === "loading") return;
    // 首播流式结束后回到 idle:再次点击走缓存可拖动。
    if (player.mode === "idle") {
      await startPlay(runId);
      return;
    }
    // error:落到下方重新生成
  }

  await startPlay(runId);
}

/**
 * 自动播入口(决策·auto-after-refetch):与手动 ▶ 同路径。
 * 已在播同一 run 则不打断;已暂停则恢复。
 */
export async function playTts(runId) {
  if (!runId) return;
  if (player.runId === runId && isActivelyPlaying()) return;
  if (player.runId === runId && player.paused && (player.mode === "streaming" || player.mode === "cached")) {
    await togglePlay(runId);
    return;
  }
  await startPlay(runId);
}

function onSeekInput(runId, value) {
  if (player.runId !== runId || player.mode !== "cached" || !player.audio) return;
  const t = Number(value);
  if (!Number.isFinite(t)) return;
  player.audio.currentTime = t;
  const total = player.durations.get(runId) ?? player.audio.duration;
  setTimeDisplay(runId, t, total);
}

/** 挂到每轮最后一条 assistant 气泡底部(与 appendRunMeta 同级)。 */
export function appendTtsControls(el, runId) {
  if (!el || !runId) return;
  el.dataset.runId = runId;

  const root = document.createElement("div");
  root.className = "msg-tts";
  root.dataset.runId = runId;
  root.innerHTML = `
    <button type="button" class="tts-play-btn" title="朗读回复">▶</button>
    <input type="range" class="tts-seek" min="0" max="0" value="0" step="0.1" disabled aria-label="朗读进度">
    <span class="tts-time" hidden></span>
    <span class="tts-status"></span>
  `;
  const btn = root.querySelector(".tts-play-btn");
  const seek = root.querySelector(".tts-seek");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void togglePlay(runId);
  });
  seek.addEventListener("input", () => onSeekInput(runId, seek.value));

  player.controls.set(runId, root);
  el.appendChild(root);
  syncControl(runId);
  // 已有缓存则立刻展示总时长。
  probeDuration(runId);
}

/** 整页重绘气泡后,把当前朗读会话刷回新控件与迷你条(决策·tts-mini-bar)。 */
export function resyncTtsControls() {
  if (!player.runId) {
    syncMiniBar();
    return;
  }
  syncControl(player.runId);
}

export function stopTtsPlayback() {
  stopAll();
}

function bindMiniBar() {
  if (!ttsMiniBar) return;
  ttsMiniStopBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    stopAll();
  });
  ttsMiniPlayBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!player.runId) return;
    void togglePlay(player.runId);
  });
  const overlays = [diffOverlay, fileBrowserOverlay].filter(Boolean);
  if (overlays.length && typeof MutationObserver !== "undefined") {
    const obs = new MutationObserver(() => syncMiniBar());
    for (const el of overlays) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
  }
}

bindMiniBar();
