/* Portable Class Recorder — runs entirely in the browser from file:// */
(() => {
  "use strict";

  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FPS = 25;
  const TIMESLICE = 5000;
  const PALETTE = [
    "#dcefe8", "#d9e8f3", "#e5e2f5", "#f3e3e6", "#fae8d4",
    "#f5f0d7", "#e4efd8", "#d9eeeb", "#d8e5dc", "#e7ece2",
    "#d8e4ee", "#e2deee", "#f0dde5", "#f5dfd1", "#f2e6c8",
    "#dcecd4", "#cfe4df", "#d2dfd8", "#e9e0d5", "#dfe7e5"
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
      segmentDuration: 10 * 60 * 1000, outputDirectory: null, outputFilename: ""
    },
    runtime: {
      compatibility: {}, worker: null, screenStream: null, screenVideo: null, microphoneStream: null,
      webcamStream: null, webcamDeviceId: "", meterContext: null, meterAnalyser: null, meterFrame: null, webcamStateSelected: true,
      outputRoot: null, sessionDirectory: null, compositionStream: null, canvasTrack: null, audioContext: null,
      recorder: null, currentSegment: null, finalizations: [], completedSegments: [], recording: false,
      rolling: false, rolloverPromise: null, stopping: false, startedAt: 0, selectedMimeType: "", filenameTouched: false,
      suppressScreenEnd: false
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
  function selectedMimeType() {
    return ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"]
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
      ["VP8 / Opus", "MediaRecorder" in window && !!selectedMimeType()],
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
    $("compatibility").classList.toggle("has-fail", checks.some(([, passed]) => !passed));
    return checks.every(([, passed]) => passed);
  }
  function mandatoryReady() { return Object.values(state.runtime.compatibility).every(Boolean); }

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
    context.drawImage(video, sx, sy, sw, sh, x, y, width, height);
  }
  function fitFont(text, start, maxWidth, weight) {
    let size = start;
    do { context.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`; size--; }
    while (size > 12 && context.measureText(text).width > maxWidth);
    return size + 1;
  }
  function renderComposition() {
    context.fillStyle = state.metadata.backgroundColor;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    if (cropValuesAreValid(state.screen)) drawSource(state.runtime.screenVideo, state.screen, state.screen);
    if (state.webcam.enabled && cropValuesAreValid(state.webcam)) drawSource(state.runtime.webcamVideo, state.webcam, state.webcam);
    context.fillStyle = "#26333b";
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
      fillDeviceSelect($("microphone"), devices.filter((device) => device.kind === "audioinput"), "Choose a microphone…", state.audio.microphoneDeviceId);
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
    if ([...select.options].some((item) => item.value === current)) select.value = current;
  }
  function stopStream(stream) { if (stream) stream.getTracks().forEach((track) => track.stop()); }
  async function activateMicrophone() {
    const id = $("microphone").value;
    if (!id) { status("Choose a microphone first.", "error"); return; }
    try {
      stopStream(state.runtime.microphoneStream);
      const audio = id === "default" ? { channelCount: 1, sampleRate: 48000 } : { deviceId: { exact: id }, channelCount: 1, sampleRate: 48000 };
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      state.runtime.microphoneStream = stream;
      state.audio.microphoneDeviceId = stream.getAudioTracks()[0].getSettings().deviceId || id;
      $("microphoneState").textContent = "Active";
      stream.getAudioTracks()[0].addEventListener("ended", () => {
        if (state.runtime.microphoneStream !== stream) return;
        state.runtime.microphoneStream = null;
        $("microphoneState").textContent = "Disconnected";
        updateRecordAvailability();
      });
      startMeter(stream);
      await refreshDevices();
      updateRecordAvailability(); status("Microphone is active.", "success");
    } catch (error) { status(`Could not activate microphone: ${error.message}`, "error"); }
  }
  async function startMeter(stream) {
    if (state.runtime.meterContext) await state.runtime.meterContext.close().catch(() => {});
    const audioContext = new AudioContext(); const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    state.runtime.meterContext = audioContext; state.runtime.meterAnalyser = analyser;
    const samples = new Uint8Array(analyser.fftSize);
    const paint = () => {
      if (state.runtime.meterAnalyser !== analyser) return;
      analyser.getByteTimeDomainData(samples);
      let square = 0; for (const sample of samples) square += ((sample - 128) / 128) ** 2;
      $("meterFill").style.width = `${Math.min(100, Math.sqrt(square / samples.length) * 210)}%`;
      state.runtime.meterFrame = requestAnimationFrame(paint);
    };
    paint();
  }
  async function activateWebcam() {
    const id = $("webcam").value;
    state.runtime.webcamStateSelected = true;
    stopStream(state.runtime.webcamStream); state.runtime.webcamStream = null; state.runtime.webcamVideo = null;
    if (id === "none") {
      state.webcam.enabled = false; state.runtime.webcamDeviceId = ""; $("webcamPreview").hidden = true; $("webcamState").textContent = "None";
      renderComposition(); updateRecordAvailability(); return;
    }
    try {
      const videoConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25, max: 30 } };
      if (id !== "default") videoConstraints.deviceId = { exact: id };
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      const video = $("webcamPreview"); video.srcObject = stream; await video.play();
      state.runtime.webcamStream = stream; state.runtime.webcamVideo = video; state.runtime.webcamDeviceId = stream.getVideoTracks()[0].getSettings().deviceId || id; state.webcam.enabled = true;
      video.hidden = false; $("webcamState").textContent = "Active";
      stream.getVideoTracks()[0].addEventListener("ended", () => { if (state.webcam.enabled) { state.webcam.enabled = false; $("webcamState").textContent = "Disconnected"; renderComposition(); } });
      await refreshDevices(); renderComposition(); updateRecordAvailability();
    } catch (error) {
      state.webcam.enabled = false;
      $("webcamState").textContent = "Unavailable — choose None to continue";
      status(`Could not activate webcam: ${error.message}. Check Chrome's camera permission, then choose the camera again.`, "error");
      updateRecordAvailability();
    }
  }
  function releaseScreen() {
    state.runtime.suppressScreenEnd = true;
    stopStream(state.runtime.screenStream);
    state.runtime.screenStream = null; state.runtime.screenVideo = null;
    $("screenState").textContent = "Not selected";
    setTimeout(() => { state.runtime.suppressScreenEnd = false; }, 0);
    renderComposition(); updateRecordAvailability();
  }
  async function selectScreen() {
    try {
      if (state.runtime.screenStream) releaseScreen();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: FPS, max: 30 } }, audio: state.audio.includeSystemAudio });
      const video = document.createElement("video"); video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      state.runtime.screenStream = stream; state.runtime.screenVideo = video;
      const track = stream.getVideoTracks()[0];
      track.addEventListener("ended", () => {
        if (state.runtime.suppressScreenEnd) return;
        state.runtime.screenStream = null; state.runtime.screenVideo = null; $("screenState").textContent = "Capture ended";
        renderComposition(); updateRecordAvailability();
        if (state.runtime.recording) stopRecording("Screen capture ended. Recording was saved safely up to its latest completed data.");
        else status("Screen capture ended.", "error");
      });
      const hasSharedAudio = stream.getAudioTracks().length > 0;
      $("systemAudioNotice").hidden = !state.audio.includeSystemAudio || hasSharedAudio;
      $("systemAudioNotice").textContent = "System audio unavailable for this capture source. Microphone recording will continue.";
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
    Object.entries(state.webcam).forEach(([k, v]) => { const i = $(k); if (i?.type === "range") i.value = v; });
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
      if (!PALETTE.includes(state.metadata.backgroundColor)) state.metadata.backgroundColor = PALETTE[0];
      [["screen", ["cropLeft", "cropRight", "cropTop", "cropBottom", "x", "y", "scale"]], ["webcam", ["cropLeft", "cropRight", "cropTop", "cropBottom", "x", "y", "scale"]]].forEach(([g, keys]) => keys.forEach(k => {
        const v = Number(p[g]?.[k]); if (Number.isFinite(v)) state[g][k] = v;
      }));
      ["title", "subtitle", "author"].forEach(name => ["x", "y", "scale"].forEach(key => {
        const value = Number(p.text?.[name]?.[key]); if (Number.isFinite(value)) state.text[name][key] = value;
      }));
      ["x", "y"].forEach(k => state.screen[k] = Math.max(0, Math.min(100, state.screen[k])));
      state.screen.scale = Math.max(20, Math.min(120, state.screen.scale));
      ["cropLeft", "cropRight", "cropTop", "cropBottom"].forEach(k => state.screen[k] = Math.max(0, Math.min(45, state.screen[k])));
      if (!cropValuesAreValid(state.screen)) Object.assign(state.screen, { cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 });
      ["x", "y"].forEach(k => state.webcam[k] = Math.max(0, Math.min(100, state.webcam[k])));
      state.webcam.scale = Math.max(5, Math.min(60, state.webcam.scale));
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
  function updateRecordAvailability() {
    const r = state.runtime;
    const missing = [];
    if (!mandatoryReady()) missing.push("compatible Chrome APIs");
    if (!r.outputRoot) missing.push("an output folder");
    const activeScreen = r.screenStream?.getVideoTracks().some(track => track.readyState !== "ended");
    const activeMicrophone = r.microphoneStream?.getAudioTracks().some(track => track.readyState !== "ended");
    if (!activeScreen) missing.push("a screen/window/tab");
    if (!activeMicrophone) missing.push("an active microphone");
    if (!r.webcamStateSelected) missing.push("a webcam choice");
    const ready = missing.length === 0;
    $("recordButton").disabled = r.recording || !ready;
    $("recordButton").title = ready ? "Start recording" : `REC needs ${missing.join(", ")}.`;
    $("recordReadiness").textContent = ready ? "REC is ready." : `REC needs: ${missing.join(", ")}.`;
    $("recordReadiness").className = `record-readiness ${ready ? "ready" : ""}`;
    if (!r.recording && ready) status("Ready to record.", "success");
    return ready;
  }
  function lock(yes) {
    document.querySelectorAll(".controls input, .controls select, .controls button").forEach(c => c.disabled = yes);
    $("recordButton").disabled = yes || !updateRecordAvailability(); $("stopButton").disabled = !yes;
  }
  async function mixedAudio() {
    const ac = new AudioContext({ sampleRate: 48000 }); await ac.resume(); const dest = ac.createMediaStreamDestination();
    ac.createMediaStreamSource(state.runtime.microphoneStream).connect(dest);
    if (state.audio.includeSystemAudio && state.runtime.screenStream.getAudioTracks().length) ac.createMediaStreamSource(new MediaStream(state.runtime.screenStream.getAudioTracks())).connect(dest);
    state.runtime.audioContext = ac; return dest.stream.getAudioTracks()[0];
  }
  async function startSegment() {
    const r = state.runtime, n = r.completedSegments.length + r.finalizations.length + 1, name = `recording-part-${String(n).padStart(3, "0")}.webm`;
    const handle = await r.sessionDirectory.getFileHandle(name, { create: true }), writable = await handle.createWritable();
    const segment = { name, handle, writable, queue: Promise.resolve(), startedAt: performance.now() };
    const recorder = new MediaRecorder(r.compositionStream, { mimeType: r.selectedMimeType, videoBitsPerSecond: state.recording.videoBitrate, audioBitsPerSecond: state.recording.audioBitrate });
    segment.recorder = recorder; recorder.ondataavailable = ({ data }) => { if (data?.size) segment.queue = segment.queue.then(() => writable.write(data)); };
    recorder.onerror = e => { if (r.recording) stopRecording(`Recorder error: ${e.error?.message || "unknown error"}`); };
    recorder.start(TIMESLICE); r.recorder = recorder; r.currentSegment = segment; return segment;
  }
  function recorderStopped(s) {
    return new Promise((resolve, reject) => { s.recorder.addEventListener("stop", resolve, { once: true }); s.recorder.addEventListener("error", e => reject(e.error || new Error("Recorder failed")), { once: true }); if (s.recorder.state !== "inactive") s.recorder.stop(); else resolve(); });
  }
  function finalise(s) {
    const task = (async () => { await s.queue; await s.writable.close(); state.runtime.completedSegments.push({ name: s.name, handle: s.handle }); $("checkpoints").textContent = state.runtime.completedSegments.length; })();
    state.runtime.finalizations.push(task); task.finally(() => state.runtime.finalizations = state.runtime.finalizations.filter(x => x !== task)); return task;
  }
  async function rollover() {
    const r = state.runtime; if (r.rolling || !r.recording || !r.currentSegment) return; r.rolling = true;
    try { const old = r.currentSegment; await recorderStopped(old); r.currentSegment = null; finalise(old).catch(e => stopRecording(`Could not save checkpoint: ${e.message}`)); if (r.recording) await startSegment(); }
    catch (e) { stopRecording(`Could not begin next segment: ${e.message}`); } finally { r.rolling = false; }
  }
  async function startRecording() {
    if (!updateRecordAvailability()) return;
    const r = state.runtime;
    try {
      state.recording.outputFilename = sanitizeFilename($("outputFilename").value); $("outputFilename").value = state.recording.outputFilename;
      r.sessionDirectory = await sessionDirectory(r.outputRoot, state.recording.outputFilename); const audio = await mixedAudio(), stream = canvas.captureStream(0);
      r.canvasTrack = stream.getVideoTracks()[0]; r.compositionStream = new MediaStream([r.canvasTrack, audio]); r.selectedMimeType = selectedMimeType();
      Object.assign(r, { completedSegments: [], finalizations: [], recording: true, stopping: false, rolling: false, startedAt: performance.now() });
      setBadge(true, "● REC"); $("previewStatus").textContent = "Recording"; $("checkpoints").textContent = "0"; lock(true); await startSegment();
      status(`Recording to ${r.sessionDirectory.name}. Completed parts are recovery checkpoints.`, "success");
    } catch (e) { r.recording = false; endTracks(); lock(false); status(`Could not start recording: ${e.message}`, "error"); }
  }
  function endTracks() {
    state.runtime.compositionStream?.getTracks().forEach(t => t.stop()); state.runtime.canvasTrack = null; state.runtime.compositionStream = null;
    state.runtime.audioContext?.close().catch(() => {}); state.runtime.audioContext = null;
  }
  async function merge() {
    const r = state.runtime, parts = [...r.completedSegments].sort((a, b) => a.name.localeCompare(b.name)); if (!parts.length) throw new Error("No valid recording checkpoint was completed.");
    const files = await Promise.all(parts.map(p => p.handle.getFile())), handle = await r.sessionDirectory.getFileHandle(state.recording.outputFilename, { create: true }), writable = await handle.createWritable();
    try { await WebmRemuxer.remuxFiles(files, writable, p => status(`${p.phase === "inspect" ? "Checking" : "Merging"} segment ${p.current} of ${p.total}…`)); await writable.close(); }
    catch (e) { await writable.abort().catch(() => {}); throw e; }
    if ($("deleteParts").checked) for (const p of parts) await r.sessionDirectory.removeEntry(p.name); return handle;
  }
  async function stopRecording(reason = "") {
    const r = state.runtime; if (r.stopping) return; r.stopping = true; r.recording = false; status(reason || "Finalizing recording checkpoints…");
    try {
      if (r.rolling) await r.rolloverPromise; const current = r.currentSegment;
      if (current) { await recorderStopped(current); r.currentSegment = null; finalise(current); }
      const settled = await Promise.allSettled([...r.finalizations]), bad = settled.find(x => x.status === "rejected"); if (bad) throw bad.reason;
      status("Creating the final WebM without re-encoding…"); const handle = await merge(); status(`Saved final recording: ${handle.name}`, "success");
    } catch (e) { status(`Finalization stopped: ${e.message}. Completed segment files were kept.`, "error"); }
    finally { endTracks(); r.stopping = false; r.recorder = null; setBadge(false, "READY"); $("previewStatus").textContent = "Preview"; $("elapsed").textContent = "00:00:00"; $("segmentElapsed").textContent = "—"; lock(false); }
  }
  function tick() {
    const r = state.runtime; if (r.screenVideo || r.webcamVideo || r.recording) renderComposition(); if (!r.recording) return;
    r.canvasTrack?.requestFrame(); const now = performance.now(); $("elapsed").textContent = formatTime(now - r.startedAt);
    if (r.currentSegment) { const age = now - r.currentSegment.startedAt; $("segmentElapsed").textContent = `${formatTime(age)} / ${formatTime(state.recording.segmentDuration)}`;
      if (age >= state.recording.segmentDuration && !r.rolling) { r.rolloverPromise = rollover(); r.rolloverPromise.finally(() => r.rolloverPromise = null); } }
  }
  const INLINE_TIMING_WORKER = `
    let timer = null;
    self.onmessage = ({ data }) => {
      if (data.type === "start") {
        clearInterval(timer);
        timer = setInterval(() => self.postMessage({ type: "tick", now: performance.now() }), data.interval || 40);
      }
      if (data.type === "stop") { clearInterval(timer); timer = null; }
    };
  `;
  function attachTimingWorker(worker, canFallback) {
    worker.onmessage = event => { if (event.data.type === "tick") tick(); };
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
    };
    state.runtime.worker = worker;
    worker.postMessage({ type: "start", interval: 1000 / FPS });
  }
  function startInlineTimingWorker() {
    try {
      const url = URL.createObjectURL(new Blob([INLINE_TIMING_WORKER], { type: "text/javascript" }));
      const worker = new Worker(url);
      attachTimingWorker(worker, false);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {
      state.runtime.compatibility["Web Workers"] = false;
      updateRecordAvailability();
    }
  }
  function startWorker() {
    try { attachTimingWorker(new Worker("worker.js"), true); }
    catch (_) { startInlineTimingWorker(); }
  }
  function initialize() {
    renderPalette(); bindInputs(); applyQuality(state.recording.quality); refreshDefaultFilename(); syncRangeOutputs(); renderComposition(); setupCompatibility(); startWorker(); refreshDevices(); updateRecordAvailability();
    $("selectScreen").onclick = selectScreen; $("activateMicrophone").onclick = activateMicrophone; $("activateWebcam").onclick = activateWebcam; $("selectOutput").onclick = selectOutputDirectory;
    $("microphone").onchange = () => { if ($("microphone").value) activateMicrophone(); };
    $("webcam").onchange = activateWebcam;
    $("recordingQuality").oninput = event => applyQuality(event.target.value);
    $("saveProfile").onclick = saveProfile; $("loadProfile").onclick = loadProfile; $("recordButton").onclick = startRecording; $("stopButton").onclick = () => stopRecording();
  }
  initialize();
})();
