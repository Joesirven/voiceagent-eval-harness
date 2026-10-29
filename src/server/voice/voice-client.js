// Browser client for live voice. Audio is mu-law at 8 kilohertz in both directions.
// The control page and the standalone voice page both call bindLeadVoice.
const RATE = 8000;
const BARGE_RMS = 0.06;
// Loud caller audio must last this long, and is ignored for this long after the microphone starts, before it cuts the agent off.
const BARGE_SUSTAIN_MS = 200;
const BARGE_GRACE_MS = 1500;
// Each socket message carries this many 8 kilohertz samples (20 milliseconds, one mu-law byte each).
const SEND_SAMPLES = 160;
// A line's first chunk starts this long after the current audio clock time.
const FIRST_CHUNK_LEAD = 0.15;
const CAP_MS = 5 * 60 * 1000;
// The ringback startBoundCall can play before a call: the North American one, 440 and 480 hertz together at a modest
// level, two seconds on and four off. The call starts RING_LEAD_MS after the ring, and the ring never outlasts RING_CAP_MS.
const RING_HERTZ = [440, 480];
const RING_LEVEL = 0.1;
const RING_ON_S = 2;
const RING_PERIOD_S = 6;
const RING_LEAD_MS = 1500;
const RING_CAP_MS = 30 * 1000;

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Same rules as mic-environment.ts (kept in sync for the static browser bundle). */
export function micAccessIssue(loc = location) {
  const host = loc.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (!window.isSecureContext && !local) {
    const port = loc.port || "4311";
    return `Microphone blocked: open http://127.0.0.1:${port}/ on the machine running the harness (not ${loc.host}). Remote HTTP cannot use the mic; use bb connect expose and HTTPS, or SSH port-forward 127.0.0.1:${port}.`;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Microphone blocked: getUserMedia unavailable (insecure page or unsupported browser).";
  }
  return null;
}

export function formatClientError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const name = err.name || "Error";
  const msg = err.message || String(err);
  return `${name}: ${msg}`;
}

function muLawEncode(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-1, Math.min(1, sample)) * 32767;
  const sign = s < 0 ? 0x80 : 0;
  s = Math.min(Math.abs(s), CLIP) + BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
function muLawDecode(byte) {
  byte = ~byte & 0xff;
  const sign = byte & 0x80, exp = (byte >> 4) & 7, mant = byte & 0x0f;
  const s = (((mant << 3) + 0x84) << exp) - 0x84;
  return (sign ? -s : s) / 32768;
}

/**
 * Low-pass filter plus decimation from inputRate to outputRate. A Blackman-windowed sinc filter with its cutoff near
 * 3.4 kilohertz is designed for the actual input rate. The filter history and the read position carry across frames,
 * so after any number of input samples the total output is ceil(input samples * outputRate / inputRate), which is
 * exactly input samples * outputRate / inputRate at whole seconds, whatever the frame sizes.
 * Returns a function that takes a Float32Array frame and returns the new output samples as a Float32Array.
 */
export function createDownsampler(inputRate, outputRate = RATE) {
  if (inputRate === outputRate) return (frame) => Float32Array.from(frame);
  const cutoff = Math.min(3400, 0.425 * Math.min(inputRate, outputRate));
  const half = Math.max(8, Math.ceil((inputRate / outputRate) * 8));
  const taps = 2 * half + 1;
  const kernel = new Float32Array(taps);
  const fc = cutoff / inputRate;
  let total = 0;
  for (let j = 0; j < taps; j++) {
    const m = j - half;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * j) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * j) / (taps - 1));
    kernel[j] = sinc * w;
    total += kernel[j];
  }
  for (let j = 0; j < taps; j++) kernel[j] /= total;
  let history = new Float32Array(taps - 1);
  let consumed = 0; // input samples seen before this frame
  let produced = 0; // output samples emitted so far
  return (frame) => {
    const available = consumed + frame.length;
    const ext = new Float32Array(history.length + frame.length);
    ext.set(history, 0);
    ext.set(frame, history.length);
    const out = [];
    // Output n reads input sample floor(n * inputRate / outputRate); integer arithmetic keeps the count exact.
    while (produced * inputRate < available * outputRate) {
      const num = produced * inputRate;
      const idx = (num - (num % outputRate)) / outputRate - consumed + history.length;
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += kernel[j] * ext[idx - j];
      out.push(acc);
      produced += 1;
    }
    history = ext.slice(ext.length - (taps - 1));
    consumed = available;
    return Float32Array.from(out);
  };
}

const MIC_WORKLET_URL = URL.createObjectURL(
  new Blob(
    [
      `class MicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch);
    return true;
  }
}
registerProcessor("mic-capture", MicCapture);`,
    ],
    { type: "application/javascript" },
  ),
);

// What the page can show of the call's audio (the Call tab waveform reads it). The state says whether a call is
// live and whether it is paused; the level is read on demand, so nothing is pushed to the page per audio frame.
// None of this changes what is captured, sent or played.
let callAudio = { live: false, paused: false };
let readCallLevel = () => 0;
const callAudioListeners = new Set();
function publishCallAudio(next) {
  callAudio = next;
  for (const listener of callAudioListeners) listener();
}
export const getCallAudio = () => callAudio;
export function subscribeCallAudio(listener) {
  callAudioListeners.add(listener);
  return () => { callAudioListeners.delete(listener); };
}
/** Loudness from 0 to 1 of the call audio right now: the caller audio being sent or the agent audio being played. Zero while paused or with no call. */
export const getCallAudioLevel = () => (callAudio.live && !callAudio.paused ? readCallLevel() : 0);

// The call's own audio tracks, for the page's visualizers: the caller microphone track, an agent tap (everything
// the call plays, also routed to a stream destination) and whether the call is ready. Tracks are the call's own;
// nothing here opens a second microphone stream. The snapshot object changes only when something is published.
let callTracks = { ready: false, caller: null, agent: null };
const callTrackListeners = new Set();
function publishCallTracks(next) {
  callTracks = { ...callTracks, ...next };
  for (const listener of callTrackListeners) listener();
}
export const getCallTracks = () => callTracks;
export function subscribeCallTracks(listener) {
  callTrackListeners.add(listener);
  return () => { callTrackListeners.delete(listener); };
}

const loudness = (samples) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
};

// The most recently bound controls (startBoundCall starts its call on them), and the ringback while it plays: its own
// audio context and oscillators, the cap timer and the timer that starts the call after the lead.
let boundCall = null;
let ring = null;

function startRing() {
  const current = { ctx: null, oscillators: [], cap: setTimeout(stopRing, RING_CAP_MS), start: undefined };
  ring = current;
  try {
    const ctx = (current.ctx = new AudioContext());
    ctx.resume?.()?.catch?.(() => {});
    // The cadence is scheduled on the ring's own audio clock up to the cap, with 10 millisecond ramps so it does not click.
    const gain = ctx.createGain();
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    for (let on = t0; on < t0 + RING_CAP_MS / 1000; on += RING_PERIOD_S) {
      gain.gain.setValueAtTime(0, on);
      gain.gain.linearRampToValueAtTime(RING_LEVEL, on + 0.01);
      gain.gain.setValueAtTime(RING_LEVEL, on + RING_ON_S - 0.01);
      gain.gain.linearRampToValueAtTime(0, on + RING_ON_S);
    }
    gain.connect(ctx.destination);
    for (const hertz of RING_HERTZ) {
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = hertz;
      oscillator.connect(gain);
      oscillator.start();
      current.oscillators.push(oscillator);
    }
  } catch {
    /* no ringback in this browser; the call still starts */
  }
}

/** Stops the ringback and a call start still waiting for the lead. Harmless when nothing rings. */
function stopRing() {
  const current = ring;
  if (!current) return;
  ring = null;
  clearTimeout(current.cap);
  clearTimeout(current.start);
  for (const oscillator of current.oscillators) { try { oscillator.stop(); } catch { /* already stopped */ } }
  try { current.ctx?.close?.()?.catch?.(() => {}); } catch { /* already closed */ }
}

export function isRinging() {
  return ring !== null;
}

/**
 * Starts a microphone call on the most recently bound controls, as clicking their startMic button would. With ring,
 * a ringback plays at once, the status shows "Ringing" and the call starts ringLeadMs later. The ring stops at the
 * first agent audio, when the call ends or fails, on the next startBoundCall, or at the cap. Does nothing with no
 * controls bound or while a call is starting or live (a ring from an earlier startBoundCall still stops).
 */
export function startBoundCall({ ring: withRing = false, ringLeadMs = RING_LEAD_MS } = {}) {
  stopRing();
  const call = boundCall;
  if (!call || call.busy()) return;
  if (!withRing) {
    call.start();
    return;
  }
  startRing();
  call.say("Ringing");
  // The startMic button may have been clicked during the lead.
  ring.start = setTimeout(() => { if (!call.busy()) call.start(); }, ringLeadMs);
}

/**
 * Wires one lead-call panel. ids names the elements. onCall(callId | null) fires
 * when a call starts and when it ends, so the surrounding page can pin its views.
 */
export function bindLeadVoice(ids, { onCall } = {}) {
  const $ = (key) => document.getElementById(ids[key]);
  let ws, ctx, tap, stream, captureNode, source, playhead = 0, started = 0, timer, paused = false;
  // True from the moment begin starts a call until stopAll ends it, so while a call is starting or live.
  let calling = false;
  const playing = new Set();
  // Loudness of the last caller frame sent, and of each scheduled agent chunk with the audio clock times it plays between.
  let callerLevel = 0;
  const agentLevels = [];
  const callLevel = () => {
    const now = ctx?.currentTime ?? 0;
    while (agentLevels.length && agentLevels[0].end <= now) agentLevels.shift();
    const agent = agentLevels.length && agentLevels[0].start <= now ? agentLevels[0].level : 0;
    return Math.max(callerLevel, agent);
  };

  const say = (m) => { const n = $("status"); if (n) n.textContent = m; };
  const log = (m) => { const n = $("log"); if (n) n.textContent += m + "\n"; };

  const micHintEl = ids.micHint ? $("micHint") : null;
  if (micHintEl) {
    const issue = micAccessIssue();
    micHintEl.textContent = issue ?? `Talk microphone: use http://127.0.0.1:${location.port || "4311"}/ on this host. Stack → Orchestrator → Direct Azure skips Pipecat.`;
    if (issue) micHintEl.classList.add("err");
  }

  function playChunk(b64) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = ctx.createBuffer(1, bytes.length, RATE);
    const ch = buf.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) { const v = muLawDecode(bytes[i]); ch[i] = v; sum += v * v; }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    if (tap) node.connect(tap);
    // The first chunk of a line gets a lead; chunks that follow continue from the playhead.
    if (playhead <= ctx.currentTime) playhead = ctx.currentTime + FIRST_CHUNK_LEAD;
    node.start(playhead);
    agentLevels.push({ start: playhead, end: playhead + buf.duration, level: bytes.length ? Math.sqrt(sum / bytes.length) : 0 });
    playhead += buf.duration;
    playing.add(node);
    node.onended = () => playing.delete(node);
  }
  function clearPlayback() {
    for (const n of playing) { try { n.stop(); } catch { /* already stopped */ } }
    playing.clear();
    agentLevels.length = 0;
    playhead = 0;
  }

  // Barge-in state: seconds of microphone audio seen since capture started, and of consecutive loud audio.
  let micSeconds = 0, loudSeconds = 0;
  // When the server owns barge-in (Azure Voice Live: its turn detection hears the caller), the loudness check stays off.
  let serverOwnsBargeIn = false;
  let downsample = null;
  let pending = new Uint8Array(SEND_SAMPLES), pendingCount = 0;
  const resetCaptureState = () => {
    micSeconds = 0; loudSeconds = 0; pendingCount = 0;
    downsample = null;
  };

  function sendMicFrame(input) {
    if (!ws || ws.readyState !== 1 || paused) return;
    const seconds = input.length / ctx.sampleRate;
    micSeconds += seconds;
    if (!serverOwnsBargeIn && micSeconds * 1000 > BARGE_GRACE_MS && playing.size && loudness(input) > BARGE_RMS) {
      loudSeconds += seconds;
      if (loudSeconds * 1000 >= BARGE_SUSTAIN_MS) {
        loudSeconds = 0;
        clearPlayback();
        ws.send(JSON.stringify({ type: "barge_in" }));
      }
    } else {
      loudSeconds = 0;
    }
    downsample ??= createDownsampler(ctx.sampleRate, RATE);
    const low = downsample(input);
    for (let i = 0; i < low.length; i++) {
      pending[pendingCount++] = muLawEncode(low[i]);
      if (pendingCount === SEND_SAMPLES) {
        ws.send(pending.slice());
        pendingCount = 0;
      }
    }
  }

  async function startMic() {
    const blocked = micAccessIssue();
    if (blocked) throw new Error(blocked);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    if (ctx.state === "suspended") await ctx.resume();
    source = ctx.createMediaStreamSource(stream);
    if (ws) publishCallTracks({ caller: stream.getAudioTracks?.()[0] ?? null });
    resetCaptureState();
    let frames = 0;

    const onInput = (input) => {
      callerLevel = ws && ws.readyState === 1 && !paused ? loudness(input) : 0;
      sendMicFrame(input);
      frames += 1;
      if (frames === 1) log("Mic capture active (sending audio to server)");
    };

    if (typeof AudioWorkletNode !== "undefined" && ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule(MIC_WORKLET_URL);
        const worklet = new AudioWorkletNode(ctx, "mic-capture");
        worklet.port.onmessage = (e) => onInput(e.data);
        source.connect(worklet);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        worklet.connect(mute);
        mute.connect(ctx.destination);
        captureNode = worklet;
        return;
      } catch (err) {
        log("AudioWorklet unavailable, using legacy capture: " + formatClientError(err));
      }
    }

    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => onInput(e.inputBuffer.getChannelData(0));
    source.connect(processor);
    processor.connect(ctx.destination);
    captureNode = processor;
  }

  /**
   * Pause holds the call: no caller audio is sent and agent playback stops where it is (the audio clock is
   * suspended, so chunks that arrive meanwhile queue up). Resume restarts both. The call itself stays open.
   */
  async function setPaused(next) {
    if (!ws || paused === next) return;
    paused = next;
    callerLevel = 0;
    // Stale partial audio and filter history must not be sent after resume.
    pendingCount = 0; loudSeconds = 0; downsample = null;
    publishCallAudio({ live: true, paused: next });
    const button = $("pause");
    if (button) { button.dataset.paused = String(next); button.setAttribute("aria-pressed", String(next)); }
    try { await (next ? ctx?.suspend() : ctx?.resume()); } catch (err) { log("Pause failed: " + formatClientError(err)); }
    say(next ? "Paused (microphone and agent speech on hold)" : "Resumed");
  }

  function stopAll() {
    stopRing();
    calling = false;
    clearInterval(timer);
    if (paused) { paused = false; const b = $("pause"); if (b) { b.dataset.paused = "false"; b.setAttribute("aria-pressed", "false"); } }
    captureNode?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    captureNode = source = stream = undefined;
    clearPlayback();
    callerLevel = 0;
    resetCaptureState();
    if (callAudio.live && readCallLevel === callLevel) {
      publishCallAudio({ live: false, paused: false });
      publishCallTracks({ ready: false, caller: null, agent: null });
    }
    tap = undefined;
    // The call's audio context is not reused, and browsers allow only a few open at once.
    try { ctx?.close?.()?.catch?.(() => {}); } catch { /* already closed */ }
    const socket = ws;
    ws = undefined;
    if (socket) { socket.onclose = null; socket.close(); }
    for (const key of ["hang", "pause", "text", "send"]) { const n = $(key); if (n) n.disabled = true; }
    for (const key of ["startMic", "startText"]) { const n = $(key); if (n) n.disabled = false; }
    onCall?.(null);
  }

  function disable(key, value) {
    const n = $(key);
    if (n) n.disabled = value;
  }

  async function begin(withMic) {
    if (ws) stopAll();
    if (withMic) {
      const blocked = micAccessIssue();
      if (blocked) {
        stopRing();
        say(blocked);
        return;
      }
    }
    calling = true;
    disable("startMic", true);
    disable("startText", true);
    say("Starting");
    let res;
    let body;
    try {
      res = await fetch("/api/play/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId: $("lead").value, direction: $("dir").value, voice: true }),
      });
      body = await res.json();
    } catch (err) {
      say("Call not started: " + formatClientError(err));
      stopAll();
      return;
    }
    if (!res.ok || body.blocked) {
      say("Call not started: " + (body.reason ?? body.error ?? res.status));
      stopAll();
      return;
    }
    onCall?.(body.callId);
    ctx = new AudioContext();
    tap = ctx.createMediaStreamDestination?.();
    readCallLevel = callLevel;
    publishCallAudio({ live: true, paused: false });
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch (err) {
      say("Audio blocked: " + formatClientError(err));
      stopAll();
      return;
    }
    const gap = $("gap")?.value ?? "900";
    const input = withMic ? "audio" : "text";
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/${body.callId}/socket?gap=${encodeURIComponent(gap)}&input=${input}`);
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      // Any status may move barge-in to the server (a transfer to a person, once connected, must not clip their audio).
      if (m.type === "status" && typeof m.bargeInOwner === "string") serverOwnsBargeIn = m.bargeInOwner === "server";
      if (m.type === "audio") {
        // The agent's first audio answers the call: the ring stops before the chunk is scheduled, so they never overlap.
        stopRing();
        playChunk(m.data);
      } else if (m.type === "clear") clearPlayback();
      else if (m.type === "error") {
        say("Voice error: " + m.code + (m.detail ? " (" + m.detail + ")" : ""));
      } else if (m.type === "status" && m.state === "ready") {
        const labels = {
          pipecat_microphone: "Live microphone (Pipecat orchestration → Azure gpt-live)",
          deepgram_pipecat: withMic ? "Live microphone (Pipecat, Deepgram speech, Azure reply)" : "Text stand-in (not live microphone; Pipecat, Deepgram speech, Azure reply)",
          pipecat_text_stand_in: "Text stand-in (not live microphone; Pipecat path, Azure gpt-live)",
          direct_azure_microphone: "Live microphone (direct Azure gpt-live, no Pipecat relay)",
          direct_azure_text: "Text stand-in (not live microphone; direct Azure gpt-live)",
          direct_azure_fallback: withMic ? "Live microphone (direct Azure gpt-live)" : "Text stand-in (not live microphone; direct Azure)",
          azure_voice_live_microphone: "Live microphone (Azure Voice Live: Azure turn detection and speech, tools on the speaking model)",
          azure_voice_live_text: "Text stand-in (not live microphone; Azure Voice Live)",
          text_stand_in: "Text stand-in (not live microphone)",
          live_audio: "Live microphone",
        };
        say(labels[m.sessionMode] ?? (withMic ? "Live microphone" : "Text stand-in (not live microphone)"));
        serverOwnsBargeIn = m.bargeInOwner === "server";
        started = Date.now();
        publishCallTracks({ ready: true, agent: tap?.stream?.getAudioTracks?.()[0] ?? null });
        disable("hang", false);
        disable("pause", false);
        disable("text", false);
        disable("send", false);
        timer = setInterval(() => {
          const clock = $("clock");
          if (clock) clock.textContent = Math.max(0, Math.round((CAP_MS - (Date.now() - started)) / 1000)) + "s left";
        }, 500);
        if (withMic) {
          try {
            await startMic();
          } catch (err) {
            stopRing();
            say("Microphone failed: " + formatClientError(err));
            ws?.send(JSON.stringify({ type: "hangup" }));
          }
        }
      } else if (m.type === "status" && m.state === "transfer_ringing") say("On hold: ringing a licensed producer");
      else if (m.type === "status" && m.state === "transfer_no_answer") say("No one picked up; back with the agent");
      else if (m.type === "status" && m.state === "transfer_connected") say("Connected to a licensed producer (transfer)");
      else if (m.type === "status" && m.state === "ended") {
        say("Ended (" + m.reason + ")");
        stopAll();
      }
    };
    const socket = ws;
    socket.onerror = () => {
      if (ws !== socket) return;
      stopRing();
      say("WebSocket error (connection to voice relay failed)");
    };
    socket.onclose = (ev) => {
      if (ws !== socket) return;
      if (!ev.wasClean && ev.code !== 1000) say(`WebSocket closed (code ${ev.code}${ev.reason ? ": " + ev.reason : ""})`);
      stopAll();
    };
  }

  async function loadLeads() {
    const leads = await (await fetch("/api/play/leads")).json();
    const leadEl = $("lead");
    if (!leadEl) return;
    leadEl.innerHTML = leads.map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join("");
    const preferred = leads.find((l) => l.talkDefault) ?? leads.find((l) => !l.onDncList) ?? leads[0];
    if (preferred) leadEl.value = preferred.id;
  }

  $("startMic").onclick = () => begin(true);
  if ($("startText")) $("startText").onclick = () => begin(false);
  if ($("pause")) $("pause").onclick = () => setPaused(!paused);
  $("hang").onclick = () => { stopRing(); ws?.send(JSON.stringify({ type: "hangup" })); };
  if ($("send") && $("text")) {
    $("send").onclick = () => {
      const t = $("text").value.trim();
      if (!t || !ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "text", text: t }));
      log("You: " + t);
      $("text").value = "";
    };
    $("text").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
  }
  boundCall = { busy: () => calling, start: () => begin(true), say };
  loadLeads();
}

if (document.getElementById("startText") && !document.getElementById("playStart")) {
  bindLeadVoice({
    lead: "lead",
    dir: "dir",
    startMic: "start",
    startText: "startText",
    hang: "hang",
    gap: "gap",
    status: "status",
    clock: "clock",
    text: "text",
    send: "send",
    log: "log",
  });
}
