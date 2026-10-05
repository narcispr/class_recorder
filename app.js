/* Portable Class Recorder — runs entirely in the browser from file:// */
(() => {
  "use strict";

  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FPS = 25;
  const TIMESLICE = 5000;
  const STOP_TIMEOUT = 5000;
  const WRITE_TIMEOUT = 15000;
  const MAX_PENDING_BYTES = 32 * 1024 * 1024;
  const PALETTE = [
    "#dcefe8", "#d9e8f3", "#e5e2f5", "#f3e3e6", "#fae8d4",
    "#f5f0d7", "#e4efd8", "#d9eeeb", "#d8e5dc", "#e7ece2",
    "#ffffff", "#000000"
  ];
  const QUALITY_LEVELS = [
    { name: "Very compact", video: 800000, audio: 96000 },
    { name: "Compact", video: 1300000, audio: 112000 },
    { name: "Balanced", video: 2100000, audio: 128000 },
    { name: "High", video: 3000000, audio: 128000 },
    { name: "Maximum", video: 4200000, audio: 160000 }
  ];

  const $ = (id) => document.getElementById(id);
  const canvas = $("compositionCanvas");
  const context = canvas.getContext("2d", { alpha: false });
  const fontSizes = new Map();
  const state = {
    metadata: { title: "Course name", subtitle: "Topic name", author: "Professor name", backgroundColor: PALETTE[0] },
    screen: { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, x: 50, y: 50, scale: 100 },
    webcam: { enabled: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, x: 82, y: 78, scale: 25 },
    text: {
      title: { x: 3.33, y: 5.93, scale: 100 },
      subtitle: { x: 3.33, y: 11.57, scale: 100 },
      author: { x: 96.67, y: 95.56, scale: 100 }
    },
    audio: { microphoneDeviceId: "", includeSystemAudio: false },
    recording: {
      width: WIDTH, height: HEIGHT, fps: FPS, quality: 3, videoBitrate: 2100000, audioBitrate: 128000,
      segmentDuration: 15000, outputDirectory: null, outputFilename: ""
    },
    runtime: {
      compatibility: {}, worker: null, screenStream: null, screenVideo: null, microphoneStream: null,
      webcamStream: null, webcamDeviceId: "", meterContext: null, meterAnalyser: null, meterFrame: null,
      outputRoot: null, sessionDirectory: null, compositionStream: null, canvasTrack: null, audioContext: null,
      recorder: null, currentSegment: null, finalizations: [], completedSegments: [], recording: false,
      rolling: false, rolloverPromise: null, stopping: false, startedAt: 0, selectedMimeType: "", filenameTouched: false,
      suppressScreenEnd: false, starting: false, recovering: false, nextSegment: 0, sessionToken: null,
      pendingBytes: 0, saveError: null, restartAttempts: 0, lastRenderAt: -Infinity, lastDashboardAt: 0,
      webcamConnecting: false, webcamRetryAt: 0, microphoneConnecting: false, microphoneRetryAt: 0,
      audioSources: new Map(), audioDestination: null
    }
  };

  function status(message, kind = "") {
    const target = $("statusMessage");
    target.textContent = message;
    target.className = `status-message ${kind}`;
  }
  function formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    return `${hours}:${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function dateStamp() { return new Date().toISOString().slice(0, 10); }
  function slug(value) {
    return String(value || "recording").toLowerCase().replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .trim().replace(/[. ]+$/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 90) || "recording";
  }
  function sanitizeFilename(value) {
    let safe = String(value || "recording.webm").replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/[. ]+$/g, "").trim().slice(0, 180);
    if (!safe) safe = "recording";
    if (!/\.webm$/i.test(safe)) safe += ".webm";
    return safe;
  }
  function defaultFilename() {
    return sanitizeFilename(`${slug(state.metadata.title)}-${slug(state.metadata.subtitle)}_${dateStamp()}.webm`);
  }
  function refreshDefaultFilename() {
    if (!state.runtime.filenameTouched) {
      state.recording.outputFilename = defaultFilename();
      $("outputFilename").value = state.recording.outputFilename;
    }
  }
  function setBadge(active, value) {
    const badge = $("recordingBadge");
    badge.textContent = value;
    badge.classList.toggle("active", active);
  }
  function selectedMimeType(includeAudio = true, includeVideo = true) {
    const types = !includeVideo
      ? ["audio/webm;codecs=opus", "audio/webm"]
      : includeAudio
      ? ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
      : ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"];
    return types
      .find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }
  function applyQuality(level) {
    const index = Math.max(1, Math.min(QUALITY_LEVELS.length, Number(level) || 3));
    const quality = QUALITY_LEVELS[index - 1];
    state.recording.quality = index;
    state.recording.videoBitrate = quality.video;
    state.recording.audioBitrate = quality.audio;
    const sizePerHour = (quality.video + quality.audio) * 3600 / 8 / 1000000000;
    const input = $("recordingQuality");
    if (input) input.value = String(index);
    const summary = $("qualitySummary");
    if (summary) summary.textContent = `${quality.name} · approx. ${sizePerHour.toFixed(2)} GB/hour`;
  }

  function setupCompatibility() {
    const testCaptureTrack = () => {
      try {
        const stream = canvas.captureStream(0);
        const track = stream.getVideoTracks()[0];
        const valid = !!track && typeof track.requestFrame === "function";
        stream.getTracks().forEach((item) => item.stop());
        return valid;
      } catch (_) { return false; }
    };
    const checks = [
      ["Camera / microphone API", !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.enumerateDevices)],
      ["Screen capture", !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)],
      ["MediaRecorder", "MediaRecorder" in window],
      ["WebM recording", "MediaRecorder" in window && !!selectedMimeType()],
      ["Local file writing", "showDirectoryPicker" in window && "FileSystemFileHandle" in window && typeof FileSystemFileHandle.prototype.createWritable === "function"],
      ["Canvas capture", !!canvas.captureStream && testCaptureTrack()],
      ["Web Workers", "Worker" in window]
    ];
    const holder = $("compatibilityItems");
    holder.replaceChildren(...checks.map(([label, passed]) => {
      const item = document.createElement("span"); item.className = `compatibility-item ${passed ? "ok" : "fail"}`;
      item.textContent = label; return item;
    }));
    state.runtime.compatibility = Object.fromEntries(checks);
    $("compatibility").classList.toggle("has-fail", checks.some(([label, passed]) => !passed && ["MediaRecorder", "WebM recording", "Local file writing", "Canvas capture", "Web Workers"].includes(label)));
    return checks.every(([, passed]) => passed);
  }
  function mandatoryReady() {
    return ["MediaRecorder", "WebM recording", "Local file writing", "Canvas capture", "Web Workers"]
      .every((name) => state.runtime.compatibility[name]);
  }

  function renderPalette() {
    const palette = $("palette");
    PALETTE.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "color-swatch"; button.style.background = color;
      button.title = color; button.setAttribute("role", "radio"); button.setAttribute("aria-label", color);
      button.setAttribute("aria-checked", String(color === state.metadata.backgroundColor));
      button.addEventListener("click", () => {
        state.metadata.backgroundColor = color;
        palette.querySelectorAll("button").forEach((item) => item.setAttribute("aria-checked", String(item === button)));
        renderComposition();
      });
      palette.append(button);
    });
  }
  function cropValuesAreValid(source = state.webcam) {
    return source.cropLeft + source.cropRight < 90 && source.cropTop + source.cropBottom < 90;
  }
  function drawSource(video, transform, crop) {
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
    if (video.srcObject && !liveTracks(video.srcObject, "video").some(track => !track.muted)) return;
    let sx = 0; let sy = 0; let sw = video.videoWidth; let sh = video.videoHeight;
    if (crop) {
      sx = video.videoWidth * crop.cropLeft / 100;
      sy = video.videoHeight * crop.cropTop / 100;
      sw = video.videoWidth * (100 - crop.cropLeft - crop.cropRight) / 100;
      sh = video.videoHeight * (100 - crop.cropTop - crop.cropBottom) / 100;
    }
    const width = WIDTH * transform.scale / 100;
    const height = width * sh / sw;
    const x = WIDTH * transform.x / 100 - width / 2;
    const y = HEIGHT * transform.y / 100 - height / 2;
    // An unavailable device must not interrupt the rest of the composition.
    try { context.drawImage(video, sx, sy, sw, sh, x, y, width, height); }
    catch (error) { if (error.name !== "InvalidStateError") throw error; }
  }
  function fitFont(text, start, maxWidth, weight) {
    const key = JSON.stringify([text, start, maxWidth, weight]);
    if (fontSizes.has(key)) return fontSizes.get(key);
    let size = start;
    do { context.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`; size--; }
    while (size > 12 && context.measureText(text).width > maxWidth);
    if (fontSizes.size >= 64) fontSizes.clear();
    fontSizes.set(key, size + 1); return size + 1;
  }
  function renderComposition() {
    context.fillStyle = state.metadata.backgroundColor;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    if (cropValuesAreValid(state.screen)) drawSource(state.runtime.screenVideo, state.screen, state.screen);
    if (state.webcam.enabled && cropValuesAreValid(state.webcam)) drawSource(state.runtime.webcamVideo, state.webcam, state.webcam);
    context.fillStyle = state.metadata.backgroundColor.toLowerCase() === "#000000" ? "#ffffff" : "#26333b";
    context.textBaseline = "top";
    const title = state.metadata.title || "";
    const subtitle = state.metadata.subtitle || "";
    const titleLayout = state.text.title, subtitleLayout = state.text.subtitle, authorLayout = state.text.author;
    const titleX = WIDTH * titleLayout.x / 100, titleY = HEIGHT * titleLayout.y / 100;
    const subtitleX = WIDTH * subtitleLayout.x / 100, subtitleY = HEIGHT * subtitleLayout.y / 100;
    const authorX = WIDTH * authorLayout.x / 100, authorY = HEIGHT * authorLayout.y / 100;
    context.font = `600 ${fitFont(title, 52 * titleLayout.scale / 100, Math.max(40, WIDTH - titleX - 32), 600)}px "Segoe UI", Arial, sans-serif`;
    context.fillText(title, titleX, titleY);
    context.font = `400 ${fitFont(subtitle, 30 * subtitleLayout.scale / 100, Math.max(40, WIDTH - subtitleX - 32), 400)}px "Segoe UI", Arial, sans-serif`;
    context.fillText(subtitle, subtitleX, subtitleY);
    const author = state.metadata.author || "";
    context.font = `500 ${fitFont(author, 24 * authorLayout.scale / 100, Math.max(40, authorX - 32), 500)}px "Segoe UI", Arial, sans-serif`;
    context.textAlign = "right"; context.textBaseline = "bottom";
    context.fillText(author, authorX, authorY);
    context.textAlign = "left"; context.textBaseline = "alphabetic";
  }

  function syncRangeOutputs() {
    document.querySelectorAll("input[type=range]").forEach((input) => {
      const output = document.querySelector(`output[for="${input.id}"]`);
      if (output) output.value = `${input.value}%`;
    });
  }
  function setAtPath(path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((object, key) => object[key], state);
    target[last] = value;
  }
  function bindInputs() {
    document.querySelectorAll("[data-state]").forEach((input) => input.addEventListener("input", () => {
      const number = input.type === "range";
      const path = input.dataset.state;
      const newValue = number ? Number(input.value) : input.value;
      if (path.includes(".crop") && !validCropChange(path, newValue)) {
        const [group, key] = path.split(".");
        input.value = state[group][key];
        status("Keep opposite crops below 90%.", "error");
        return;
      }
      setAtPath(path, newValue);
      if (number) syncRangeOutputs();
      if (path === "metadata.title" || path === "metadata.subtitle") refreshDefaultFilename();
      renderComposition();
    }));
    $("includeSystemAudio").addEventListener("change", (event) => {
      state.audio.includeSystemAudio = event.target.checked;
      if (state.runtime.screenStream) {
        releaseScreen();
        status("Screen capture was cleared. Select it again to apply the shared-audio choice.");
      }
    });
    $("outputFilename").addEventListener("input", (event) => {
      state.runtime.filenameTouched = true;
      state.recording.outputFilename = event.target.value;
    });
    $("outputFilename").addEventListener("change", () => {
      state.recording.outputFilename = sanitizeFilename($("outputFilename").value);
      $("outputFilename").value = state.recording.outputFilename;
    });
  }
  function validCropChange(path, value) {
    const [group, key] = path.split(".");
    const next = { ...state[group], [key]: value };
    return next.cropLeft + next.cropRight < 90 && next.cropTop + next.cropBottom < 90;
  }

  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      fillDeviceSelect($("microphone"), devices.filter((device) => device.kind === "audioinput"), "None", state.audio.microphoneDeviceId);
      fillDeviceSelect($("webcam"), devices.filter((device) => device.kind === "videoinput"), "None", state.runtime.webcamDeviceId, true);
    } catch (error) { status(`Could not enumerate devices: ${error.message}`, "error"); }
  }
  function fillDeviceSelect(select, devices, emptyText, selectedId, isCamera = false) {
    const current = selectedId || (isCamera ? select.value : "");
    select.replaceChildren();
    const empty = new Option(emptyText, isCamera ? "none" : ""); select.add(empty);
    devices.forEach((device, index) => {
      const value = device.deviceId || "default";
      select.add(new Option(device.label || `${isCamera ? "Camera" : "Microphone"} ${index + 1}`, value));
    });
    if (current && current !== "none" && ![...select.options].some(item => item.value === current)) {
      select.add(new Option("Disconnected device (will retry)", current));
    }
    if ([...select.options].some((item) => item.value === current)) select.value = current;
  }
  function stopStream(stream) { if (stream) stream.getTracks().forEach((track) => track.stop()); }
  function releaseMicrophone() {
    disconnectMixedAudio(state.runtime.microphoneStream);
    stopStream(state.runtime.microphoneStream);
    state.runtime.microphoneStream = null;
    state.audio.microphoneDeviceId = "";
    state.runtime.meterAnalyser = null;
    cancelAnimationFrame(state.runtime.meterFrame);
    state.runtime.meterContext?.close().catch(() => {});
    state.runtime.meterContext = null;
    $("meterFill").style.width = "0%";
    $("microphoneState").textContent = "Inactive";
    updateRecordAvailability();
  }
  async function activateMicrophone() {
    const r = state.runtime;
    if (r.microphoneConnecting) return;
    const id = $("microphone").value;
    releaseMicrophone();
    if (!id) return;
    r.microphoneConnecting = true;
    state.audio.microphoneDeviceId = id;
    try {
      const audio = id === "default" ? { channelCount: 1, sampleRate: 48000 } : { deviceId: { exact: id }, channelCount: 1, sampleRate: 48000 };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      state.runtime.microphoneStream = stream;
      connectMixedAudio(stream.getAudioTracks()[0]);
      state.audio.microphoneDeviceId = stream.getAudioTracks()[0].getSettings().deviceId || id;
      $("microphoneState").textContent = "Active";
      stream.getAudioTracks()[0].addEventListener("ended", () => {
        if (state.runtime.microphoneStream !== stream) return;
        disconnectMixedAudio(stream);
        state.runtime.microphoneStream = null;
        $("microphoneState").textContent = "Disconnected";
        updateRecordAvailability();
        status("Microphone disconnected. Recording continues; reconnecting automatically.", "error");
      });
      startMeter(stream);
      await refreshDevices();
      updateRecordAvailability(); status("Microphone is active.", "success");
    } catch (error) { status(`Could not activate microphone: ${error.message}`, "error"); }
    finally { r.microphoneConnecting = false; r.microphoneRetryAt = performance.now() + 5000; }
  }
  async function startMeter(stream) {
    if (state.runtime.meterContext) await state.runtime.meterContext.close().catch(() => {});
    const audioContext = new AudioContext(); const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    state.runtime.meterContext = audioContext; state.runtime.meterAnalyser = analyser;
    const samples = new Uint8Array(analyser.fftSize);
    let lastPaint = 0;
    const paint = (now = 0) => {
      if (state.runtime.meterAnalyser !== analyser) return;
      if (now - lastPaint >= 100 && !document.hidden) {
        lastPaint = now;
        analyser.getByteTimeDomainData(samples);
        let square = 0; for (const sample of samples) square += ((sample - 128) / 128) ** 2;
        $("meterFill").style.width = `${Math.min(100, Math.sqrt(square / samples.length) * 210)}%`;
      }
      state.runtime.meterFrame = requestAnimationFrame(paint);
    };
    paint();
  }
  async function activateWebcam() {
    const r = state.runtime;
    if (r.webcamConnecting) return;
    const id = $("webcam").value;
    stopStream(state.runtime.webcamStream); state.runtime.webcamStream = null; state.runtime.webcamVideo = null;
    if (id === "none") {
      state.webcam.enabled = false; state.runtime.webcamDeviceId = ""; $("webcamPreview").hidden = true; $("webcamState").textContent = "None";
      renderComposition(); updateRecordAvailability(); return;
    }
    r.webcamConnecting = true; r.webcamDeviceId = id;
    let stream = null;
    try {
      const videoConstraints = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: FPS, max: FPS } };
      if (id !== "default") videoConstraints.deviceId = { exact: id };
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      const video = $("webcamPreview"); video.srcObject = stream; await video.play();
      state.runtime.webcamStream = stream; state.runtime.webcamVideo = video; state.runtime.webcamDeviceId = stream.getVideoTracks()[0].getSettings().deviceId || id; state.webcam.enabled = true;
      video.hidden = false; $("webcamState").textContent = "Active";
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        if (state.runtime.webcamStream !== stream || !state.webcam.enabled) return;
        state.webcam.enabled = false;
        state.runtime.webcamStream = null; state.runtime.webcamVideo = null;
        video.srcObject = null; video.hidden = true;
        $("webcamState").textContent = "Disconnected";
        renderComposition();
        updateRecordAvailability();
        status("Webcam disconnected. Recording continues; reconnecting automatically.", "error");
      });
      const track = stream.getVideoTracks()[0];
      track.addEventListener("mute", () => { if (r.webcamStream === stream) $("webcamState").textContent = "Signal interrupted · recording continues"; });
      track.addEventListener("unmute", () => { if (r.webcamStream === stream) $("webcamState").textContent = "Active"; });
      await refreshDevices(); renderComposition(); updateRecordAvailability();
    } catch (error) {
      stopStream(stream);
      state.webcam.enabled = false;
      $("webcamState").textContent = "Unavailable";
      status(`Could not activate webcam: ${error.message}. Check Chrome's camera permission, then choose the camera again.`, "error");
      updateRecordAvailability();
    }
    finally { r.webcamConnecting = false; r.webcamRetryAt = performance.now() + 5000; }
  }
  function releaseScreen() {
    state.runtime.suppressScreenEnd = true;
    stopStream(state.runtime.screenStream);
    state.runtime.screenStream = null; state.runtime.screenVideo = null;
    $("screenState").textContent = "Not selected";
    $("systemAudioNotice").hidden = true;
    setTimeout(() => { state.runtime.suppressScreenEnd = false; }, 0);
    renderComposition(); updateRecordAvailability();
  }
  async function selectScreen() {
    try {
      if (state.runtime.screenStream) releaseScreen();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: {
        width: { ideal: WIDTH, max: WIDTH }, height: { ideal: HEIGHT, max: HEIGHT },
        frameRate: { ideal: FPS, max: FPS }
      }, audio: state.audio.includeSystemAudio });
      const video = document.createElement("video"); video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      state.runtime.screenStream = stream; state.runtime.screenVideo = video;
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        if (state.runtime.suppressScreenEnd || state.runtime.screenStream !== stream) return;
        disconnectMixedAudio(stream);
        state.runtime.screenStream = null; state.runtime.screenVideo = null; $("screenState").textContent = "Capture ended";
        renderComposition(); updateRecordAvailability();
        if (state.runtime.recording) status("Screen capture ended. Recording continues with the available sources; press STOP to finish.", "error");
        else status("Screen capture ended.", "error");
      });
      const hasSharedAudio = stream.getAudioTracks().length > 0;
      $("systemAudioNotice").hidden = !state.audio.includeSystemAudio || hasSharedAudio;
      $("systemAudioNotice").textContent = "System audio unavailable for this capture source. Only an active microphone will supply audio.";
      $("systemAudioNotice").className = "field-note warning";
      $("screenState").textContent = hasSharedAudio ? "Ready · shared audio available" : "Ready";
      renderComposition(); updateRecordAvailability(); status("Screen capture is ready.", "success");
    } catch (error) {
      if (error.name !== "AbortError" && error.name !== "NotAllowedError") status(`Could not start screen capture: ${error.message}`, "error");
    }
  }
  function profile() {
    const { metadata, screen } = state, { cropLeft, cropRight, cropTop, cropBottom, x, y, scale } = state.webcam;
    return { version: 1, metadata: { ...metadata }, screen: { ...screen }, webcam: { cropLeft, cropRight, cropTop, cropBottom, x, y, scale },
      text: { title: { ...state.text.title }, subtitle: { ...state.text.subtitle }, author: { ...state.text.author } },
      recording: { width: WIDTH, height: HEIGHT, fps: FPS, quality: state.recording.quality, segmentDuration: state.recording.segmentDuration } };
  }
  async function saveProfile() {
    try {
      const h = await showSaveFilePicker({ suggestedName: `${slug(state.metadata.title)}-profile.json`, types: [{ description: "Recorder profile", accept: { "application/json": [".json"] } }] });
      const w = await h.createWritable(); await w.write(JSON.stringify(profile(), null, 2)); await w.close();
      status("Portable profile saved. It contains no device selection or output path.", "success");
    } catch (e) { if (e.name !== "AbortError") status(`Could not save profile: ${e.message}`, "error"); }
  }
  function reflect() {
    ["title", "subtitle", "author"].forEach(k => $(k).value = state.metadata[k]);
    Object.entries(state.screen).forEach(([k, v]) => { const i = $(`screen${k[0].toUpperCase()}${k.slice(1)}`); if (i) i.value = v; });
    Object.entries(state.webcam).forEach(([k, v]) => { const i = $(k.startsWith("crop") ? k : `webcam${k[0].toUpperCase()}${k.slice(1)}`); if (i?.type === "range") i.value = v; });
    Object.entries(state.text).forEach(([name, layout]) => Object.entries(layout).forEach(([key, value]) => {
      const input = $(`${name}${key[0].toUpperCase()}${key.slice(1)}`);
      if (input) input.value = value;
    }));
    document.querySelectorAll("#palette button").forEach(b => b.setAttribute("aria-checked", String(b.title === state.metadata.backgroundColor)));
    syncRangeOutputs(); refreshDefaultFilename(); renderComposition();
  }
  async function loadProfile() {
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: "Recorder profile", accept: { "application/json": [".json"] } }] });
      const p = JSON.parse(await (await h.getFile()).text()); if (!p || typeof p !== "object") throw new Error("Invalid profile");
      ["title", "subtitle", "author", "backgroundColor"].forEach(k => { if (typeof p.metadata?.[k] === "string") state.metadata[k] = p.metadata[k]; });
      if (!/^#[0-9a-f]{6}$/i.test(state.metadata.backgroundColor)) state.metadata.backgroundColor = PALETTE[0];
      [["screen", ["cropLeft", "cropRight", "cropTop", "cropBottom", "x", "y", "scale"]], ["webcam", ["cropLeft", "cropRight", "cropTop", "cropBottom", "x", "y", "scale"]]].forEach(([g, keys]) => keys.forEach(k => {
        const v = Number(p[g]?.[k]); if (Number.isFinite(v)) state[g][k] = v;
      }));
      ["title", "subtitle", "author"].forEach(name => ["x", "y", "scale"].forEach(key => {
        const value = Number(p.text?.[name]?.[key]); if (Number.isFinite(value)) state.text[name][key] = value;
      }));
      ["x", "y"].forEach(k => state.screen[k] = Math.max(0, Math.min(100, state.screen[k])));
      state.screen.scale = Math.max(10, Math.min(150, state.screen.scale));
      ["cropLeft", "cropRight", "cropTop", "cropBottom"].forEach(k => state.screen[k] = Math.max(0, Math.min(45, state.screen[k])));
      if (!cropValuesAreValid(state.screen)) Object.assign(state.screen, { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 });
      ["x", "y"].forEach(k => state.webcam[k] = Math.max(0, Math.min(100, state.webcam[k])));
      state.webcam.scale = Math.max(10, Math.min(150, state.webcam.scale));
      ["cropLeft", "cropRight", "cropTop", "cropBottom"].forEach(k => state.webcam[k] = Math.max(0, Math.min(45, state.webcam[k])));
      if (!cropValuesAreValid()) Object.assign(state.webcam, { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 });
      ["title", "subtitle", "author"].forEach(name => {
        ["x", "y"].forEach(key => state.text[name][key] = Math.max(0, Math.min(100, state.text[name][key])));
        state.text[name].scale = Math.max(50, Math.min(200, state.text[name].scale));
      });
      if (Number.isFinite(Number(p.recording?.quality))) applyQuality(p.recording.quality);
      reflect(); status("Profile loaded. Devices and output location were unchanged.", "success");
    } catch (e) { if (e.name !== "AbortError") status(`Could not load profile: ${e.message}`, "error"); }
  }
  async function selectOutputDirectory() {
    try {
      const dir = await showDirectoryPicker({ mode: "readwrite" }); state.runtime.outputRoot = dir; state.recording.outputDirectory = dir;
      $("outputState").textContent = dir.name || "Folder selected"; updateRecordAvailability(); status("Output folder selected. REC creates a session folder.", "success");
    } catch (e) { if (e.name !== "AbortError") status(`Could not select output folder: ${e.message}`, "error"); }
  }
  async function sessionDirectory(root, filename) {
    const base = sanitizeFilename(filename).replace(/\.webm$/i, "") || "recording";
    for (let n = 0; n < 1000; n++) { const name = n ? `${base}-${n}` : base; try { await root.getDirectoryHandle(name); } catch (e) {
      if (e.name === "NotFoundError") return root.getDirectoryHandle(name, { create: true }); throw e;
    } } throw new Error("Could not find an unused session folder.");
  }
  function liveTracks(stream, kind) {
    return (stream?.getTracks() || []).filter(track => track.kind === kind && track.readyState === "live");
  }
  function hasActiveVideoSource() {
    return liveTracks(state.runtime.screenStream, "video").length > 0 ||
      (state.webcam.enabled && liveTracks(state.runtime.webcamStream, "video").length > 0);
  }
  function activeAudioTracks() {
    return [...liveTracks(state.runtime.microphoneStream, "audio"),
      ...(state.audio.includeSystemAudio ? liveTracks(state.runtime.screenStream, "audio") : [])];
  }
  function hasActiveRecordingSource() {
    return hasActiveVideoSource() || activeAudioTracks().length > 0;
  }
  function updateRecordAvailability() {
    const r = state.runtime;
    const missing = [];
    if (!mandatoryReady()) missing.push("compatible Chrome APIs");
    if (!r.outputRoot) missing.push("an output folder");
    if (!hasActiveRecordingSource()) missing.push("at least one active source (microphone, screen, or webcam)");
    const ready = missing.length === 0;
    $("recordButton").disabled = r.recording || r.stopping || r.starting || r.recovering || !ready;
    $("recordButton").title = ready ? "Start recording" : `REC needs ${missing.join(", ")}.`;
    $("recordReadiness").textContent = ready ? "REC is ready." : `REC needs: ${missing.join(", ")}.`;
    $("recordReadiness").className = `record-readiness ${ready ? "ready" : ""}`;
    return ready;
  }
  function lock(yes) {
    document.querySelectorAll(".controls input, .controls select, .controls button").forEach(c => c.disabled = yes);
    $("recordButton").disabled = yes || !updateRecordAvailability(); $("stopButton").disabled = !yes;
  }
  async function mixedAudio() {
    const tracks = activeAudioTracks();
    if (!tracks.length) return null;
    const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume(); const dest = ac.createMediaStreamDestination();
    state.runtime.audioContext = ac; state.runtime.audioDestination = dest;
    tracks.forEach(connectMixedAudio); return dest.stream.getAudioTracks()[0];
  }
  function connectMixedAudio(track) {
    const r = state.runtime;
    if (!r.audioContext || !r.audioDestination || r.audioSources.has(track)) return;
    const source = r.audioContext.createMediaStreamSource(new MediaStream([track]));
    source.connect(r.audioDestination); r.audioSources.set(track, source);
  }
  function disconnectMixedAudio(stream) {
    for (const track of stream?.getAudioTracks() || []) {
      state.runtime.audioSources.get(track)?.disconnect(); state.runtime.audioSources.delete(track);
    }
  }
  function withTimeout(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]).finally(() => clearTimeout(timer));
  }
  function saveFailed(error) {
    const r = state.runtime;
    r.saveError ||= error;
    if (r.recording) void stopRecording(`Saving failed: ${error.message}`);
  }
  async function startSegment() {
    const r = state.runtime, name = `recording-part-${String(++r.nextSegment).padStart(3, "0")}.webm`;
    const handle = await withTimeout(r.sessionDirectory.getFileHandle(name, { create: true }), WRITE_TIMEOUT, "Output folder is not responding.");
    const writable = await openWritable(handle);
    if (!r.recording) { void writable.abort().catch(() => {}); return null; }
    const segment = { name, handle, writable, queue: Promise.resolve(), startedAt: performance.now(),
      bytes: 0, writeError: null, abandoned: false, stopRequested: false, sessionToken: r.sessionToken };
    try {
      const recorder = new MediaRecorder(r.compositionStream, { mimeType: r.selectedMimeType,
        videoBitsPerSecond: state.recording.videoBitrate, audioBitsPerSecond: state.recording.audioBitrate });
      segment.recorder = recorder;
      segment.stopped = new Promise(resolve => recorder.addEventListener("stop", () => {
        resolve();
        if (!segment.stopRequested && r.recording && r.currentSegment === segment) {
          beginRollover("Encoder stopped unexpectedly.");
        }
      }, { once: true }));
      recorder.ondataavailable = ({ data }) => {
        if (!data?.size || segment.abandoned || segment.writeError || r.sessionToken !== segment.sessionToken) return;
        if (r.pendingBytes + data.size > MAX_PENDING_BYTES) {
          segment.writeError = new Error("The output disk cannot keep up (32 MB of pending writes).");
          saveFailed(segment.writeError); return;
        }
        r.pendingBytes += data.size; segment.bytes += data.size;
        segment.queue = segment.queue.then(async () => {
          if (!segment.writeError && !segment.abandoned) {
            await withTimeout(writable.write(data), WRITE_TIMEOUT, "The output disk stopped responding.");
          }
        }).catch(error => { segment.writeError = error; if (r.sessionToken === segment.sessionToken) saveFailed(error); })
          .finally(() => { if (r.sessionToken === segment.sessionToken) r.pendingBytes -= data.size; });
      };
      // The stop event follows error and the last dataavailable event. Keep that last data.
      recorder.onerror = event => { segment.recorderError = event.error || new Error("Encoder failed."); };
      recorder.start(TIMESLICE); r.recorder = recorder; r.currentSegment = segment; return segment;
    } catch (error) { void writable.abort().catch(() => {}); throw error; }
  }
  async function recorderStopped(segment) {
    segment.stopRequested = true;
    if (segment.recorder.state !== "inactive") segment.recorder.stop();
    // An inactive recorder can still have its final data and stop event queued.
    await withTimeout(segment.stopped, STOP_TIMEOUT, "Encoder did not finish within five seconds.");
  }
  function abandon(segment) {
    segment.abandoned = true;
    segment.stopRequested = true;
    try { if (segment.recorder.state !== "inactive") segment.recorder.stop(); } catch (_) {}
    void segment.writable.abort().catch(() => {});
  }
  function finalise(segment) {
    if (segment.finalization) return segment.finalization;
    const r = state.runtime;
    const task = (async () => {
      await segment.queue;
      if (segment.writeError) { abandon(segment); throw segment.writeError; }
      if (!segment.bytes) { abandon(segment); return; }
      await withTimeout(segment.writable.close(), WRITE_TIMEOUT, "Could not close a recovery checkpoint.");
      r.completedSegments.push({ name: segment.name, handle: segment.handle });
      $("checkpoints").textContent = r.completedSegments.length;
    })();
    segment.finalization = task; r.finalizations.push(task);
    const cleanup = () => { r.finalizations = r.finalizations.filter(item => item !== task); };
    // Handle both branches: an ignored finally() promise would create unhandled rejections.
    task.then(cleanup, error => { cleanup(); saveFailed(error); });
    return task;
  }
  function beginRollover(reason = "") {
    const r = state.runtime;
    if (r.rolling || !r.recording || !r.currentSegment) return;
    r.rolling = true;
    const task = rollover(reason); r.rolloverPromise = task;
    void task.then(() => { if (r.rolloverPromise === task) r.rolloverPromise = null; });
  }
  async function rollover(reason) {
    const r = state.runtime, old = r.currentSegment;
    let restart = !!reason || !!old.recorderError;
    try {
      try { await recorderStopped(old); }
      catch (error) { abandon(old); restart = true; reason = error.message; }
      r.currentSegment = null;
      if (!old.abandoned) void finalise(old);
      // Bound open writers as well as queued bytes on slow USB disks.
      if (r.finalizations.length >= 2) await Promise.all(r.finalizations);
      if (restart) {
        if (++r.restartAttempts > 3) throw new Error("Encoder failed repeatedly. Earlier checkpoints are safe.");
        status(`${reason || old.recorderError?.message} Restarting the encoder; earlier checkpoints are safe.`, "error");
      } else r.restartAttempts = 0;
      if (r.recording) await startSegment();
    } catch (error) {
      // Do not await stopRecording here: it waits for this rollover to finish.
      if (r.recording) void stopRecording(`Could not continue recording: ${error.message}`);
    } finally { r.rolling = false; }
  }
  async function startRecording() {
    const r = state.runtime;
    if (r.recording || r.starting || r.stopping || r.recovering) return;
    if (!updateRecordAvailability()) return;
    r.starting = true; lock(true); $("stopButton").disabled = true;
    try {
      state.recording.outputFilename = sanitizeFilename($("outputFilename").value); $("outputFilename").value = state.recording.outputFilename;
      r.sessionDirectory = await sessionDirectory(r.outputRoot, state.recording.outputFilename);
      const audio = await mixedAudio(), includeVideo = hasActiveVideoSource();
      r.canvasTrack = includeVideo ? canvas.captureStream(FPS).getVideoTracks()[0] : null;
      r.compositionStream = new MediaStream([r.canvasTrack, audio].filter(Boolean));
      r.selectedMimeType = selectedMimeType(!!audio, includeVideo);
      if (!r.selectedMimeType) throw new Error("This recording mode is not supported by the browser.");
      Object.assign(r, { completedSegments: [], finalizations: [], recording: true, stopping: false,
        rolling: false, rolloverPromise: null, currentSegment: null, nextSegment: 0, pendingBytes: 0,
        saveError: null, restartAttempts: 0, sessionToken: {}, startedAt: performance.now(), lastDashboardAt: 0 });
      setBadge(true, "● REC"); $("previewStatus").textContent = "Recording"; $("checkpoints").textContent = "0"; lock(true);
      $("stopButton").disabled = true; await startSegment(); $("stopButton").disabled = false;
      status(`Recording to ${r.sessionDirectory.name} at up to ${FPS} fps. Recovery parts close every 15 seconds.`, "success");
    } catch (e) { r.recording = false; endTracks(); lock(false); setBadge(false, "READY"); $("previewStatus").textContent = "Preview"; status(`Could not start recording: ${e.message}`, "error"); }
    finally { r.starting = false; updateRecordAvailability(); }
  }
  function endTracks() {
    state.runtime.compositionStream?.getTracks().forEach(t => t.stop()); state.runtime.canvasTrack = null; state.runtime.compositionStream = null;
    state.runtime.audioContext?.close().catch(() => {}); state.runtime.audioContext = null;
    state.runtime.audioSources.clear(); state.runtime.audioDestination = null;
  }
  async function merge() {
    const r = state.runtime, parts = [...r.completedSegments].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); if (!parts.length) throw new Error("No valid recording checkpoint was completed.");
    const files = await withTimeout(Promise.all(parts.map(p => p.handle.getFile())), WRITE_TIMEOUT, "Could not read the saved checkpoints.");
    const handle = await withTimeout(r.sessionDirectory.getFileHandle(state.recording.outputFilename, { create: true }), WRITE_TIMEOUT, "Output folder is not responding.");
    const writable = await openWritable(handle);
    try {
      await WebmRemuxer.remuxFiles(files, timedWriter(writable), p => status(`${p.phase === "inspect" ? "Checking" : "Merging"} segment ${p.current} of ${p.total}…`));
      await withTimeout(writable.close(), WRITE_TIMEOUT, "Could not close the final recording.");
    } catch (e) { void writable.abort().catch(() => {}); throw e; }
    if ($("deleteParts").checked && !r.saveError) for (const p of parts) {
      await withTimeout(r.sessionDirectory.removeEntry(p.name), WRITE_TIMEOUT, "Could not delete a temporary part.");
    }
    return handle;
  }
  async function openWritable(handle) {
    const opening = handle.createWritable();
    try { return await withTimeout(opening, WRITE_TIMEOUT, "Could not open an output file."); }
    catch (error) { opening.then(writer => writer.abort().catch(() => {}), () => {}); throw error; }
  }
  function timedWriter(writable) {
    return { write: data => withTimeout(writable.write(data), WRITE_TIMEOUT, "The output disk stopped responding.") };
  }
  async function stopRecording(reason = "") {
    const r = state.runtime; if (r.stopping || !r.recording) return;
    r.stopping = true; r.recording = false; $("stopButton").disabled = true;
    setBadge(false, "SAVING"); status(reason || "Finalizing recording checkpoints…");
    try {
      if (r.rolling) await r.rolloverPromise;
      const current = r.currentSegment;
      if (current) {
        try { await recorderStopped(current); void finalise(current); }
        catch (error) { abandon(current); reason ||= error.message; }
        r.currentSegment = null;
      }
      await Promise.allSettled([...r.finalizations]);
      // Merge the already committed parts even if the last encoder or writer failed.
      status("Creating the final WebM without re-encoding…"); const handle = await merge();
      const issue = r.saveError?.message || reason;
      status(`Saved final recording: ${handle.name}${issue ? `. ${issue} Earlier completed parts were preserved.` : ""}`, issue ? "error" : "success");
    } catch (e) { status(`Finalization stopped: ${e.message}. Completed segment files were kept.`, "error"); }
    finally { endTracks(); r.stopping = false; r.recorder = null; setBadge(false, "READY"); $("previewStatus").textContent = "Preview"; $("elapsed").textContent = "00:00:00"; $("segmentElapsed").textContent = "—"; lock(false); }
  }
  async function recoverRecording() {
    const r = state.runtime;
    if (r.recording || r.stopping || r.starting || r.recovering) return;
    r.recovering = true; lock(true); $("stopButton").disabled = true;
    let writable = null;
    try {
      const directory = await showDirectoryPicker({ mode: "readwrite" });
      const parts = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file" && /^recording-part-\d+\.webm$/i.test(name)) {
          const file = await withTimeout(handle.getFile(), WRITE_TIMEOUT, "Could not read a recovery part."); if (file.size) parts.push({ name, file });
        }
      }
      parts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (!parts.length) throw new Error("This folder contains no saved recording parts. Select the session folder.");
      // Never overwrite an existing final or previous recovery.
      let handle;
      for (let number = 1; number < 1000; number++) {
        const name = sanitizeFilename(`${directory.name}-recovered${number > 1 ? `-${number}` : ""}.webm`);
        try { await directory.getFileHandle(name); }
        catch (error) {
          if (error.name !== "NotFoundError") throw error;
          handle = await directory.getFileHandle(name, { create: true }); break;
        }
      }
      if (!handle) throw new Error("Could not find an unused recovery filename.");
      writable = await openWritable(handle);
      const result = await WebmRemuxer.remuxFiles(parts.map(part => part.file), timedWriter(writable),
        progress => status(`Recovering part ${progress.current} of ${progress.total}…`), { skipInvalid: true });
      await withTimeout(writable.close(), WRITE_TIMEOUT, "Could not close the recovered recording."); writable = null;
      const skipped = result.skipped.length ? ` Skipped damaged parts: ${result.skipped.map(part => part.name).join(", ")}.` : "";
      status(`Recovered ${result.segments} parts to ${handle.name}.${skipped} Original parts were kept.`, skipped ? "error" : "success");
    } catch (error) {
      if (writable) void writable.abort().catch(() => {});
      if (error.name !== "AbortError") status(`Could not recover recording: ${error.message}. Original parts were kept.`, "error");
    } finally { r.recovering = false; lock(false); }
  }
  function tick() {
    const r = state.runtime, now = performance.now();
    if (now - r.lastRenderAt >= 1000 / FPS - 0.5 && (r.screenVideo || r.webcamVideo || r.canvasTrack)) {
      r.lastRenderAt = now; renderComposition(); r.canvasTrack?.requestFrame();
    }
    if (!r.recording) return;
    if (r.currentSegment && now - r.currentSegment.startedAt >= state.recording.segmentDuration) beginRollover();
    if (now - r.lastDashboardAt < 1000) return;
    r.lastDashboardAt = now;
    $("elapsed").textContent = formatTime(now - r.startedAt);
    if (r.currentSegment) $("segmentElapsed").textContent = `${formatTime(now - r.currentSegment.startedAt)} / ${formatTime(state.recording.segmentDuration)}`;
    if (r.canvasTrack && r.webcamDeviceId && !liveTracks(r.webcamStream, "video").length && now >= r.webcamRetryAt) {
      void activateWebcam();
    }
    if (r.audioContext && state.audio.microphoneDeviceId && !liveTracks(r.microphoneStream, "audio").length && now >= r.microphoneRetryAt) {
      void activateMicrophone();
    }
    if (r.audioContext?.state === "suspended") void r.audioContext.resume().catch(() => {});
  }
  function attachTimingWorker(worker, canFallback) {
    worker.onmessage = event => {
      if (event.data.type !== "tick") return;
      try { tick(); }
      catch (error) { status(`Preview interrupted: ${error.message}. Saved checkpoints are kept.`, "error"); }
      finally { worker.postMessage({ type: "ack" }); }
    };
    worker.onerror = event => {
      event.preventDefault();
      if (state.runtime.worker !== worker) return;
      worker.terminate();
      if (canFallback) {
        startInlineTimingWorker();
        return;
      }
      state.runtime.compatibility["Web Workers"] = false;
      updateRecordAvailability();
      status("Timing worker failed; recording is disabled.", "error");
      if (state.runtime.recording) void stopRecording("Timing worker failed.");
    };
    state.runtime.worker = worker;
    worker.postMessage({ type: "start", interval: 1000 / FPS });
  }
  function startInlineTimingWorker() {
    try {
      const url = URL.createObjectURL(new Blob([`(${timingWorker.toString()})();`], { type: "text/javascript" }));
      const worker = new Worker(url);
      attachTimingWorker(worker, false);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {
      state.runtime.compatibility["Web Workers"] = false;
      updateRecordAvailability();
      if (state.runtime.recording) void stopRecording("Could not restart the timing worker.");
    }
  }
  function startWorker() {
    try { attachTimingWorker(new Worker("worker.js"), true); }
    catch (_) { startInlineTimingWorker(); }
  }
  function initialize() {
    renderPalette(); bindInputs(); applyQuality(state.recording.quality); refreshDefaultFilename(); syncRangeOutputs(); renderComposition(); setupCompatibility(); startWorker(); refreshDevices(); updateRecordAvailability();
    $("selectScreen").onclick = selectScreen; $("clearScreen").onclick = releaseScreen; $("activateMicrophone").onclick = activateMicrophone; $("activateWebcam").onclick = activateWebcam; $("selectOutput").onclick = selectOutputDirectory;
    $("microphone").onchange = activateMicrophone;
    $("webcam").onchange = activateWebcam;
    $("recordingQuality").oninput = event => applyQuality(event.target.value);
    $("saveProfile").onclick = saveProfile; $("loadProfile").onclick = loadProfile; $("recordButton").onclick = startRecording; $("stopButton").onclick = () => stopRecording();
    $("recoverRecording").onclick = recoverRecording;
    window.addEventListener("beforeunload", event => {
      if (state.runtime.recording || state.runtime.stopping) { event.preventDefault(); event.returnValue = ""; }
    });
  }
  initialize();
})();
