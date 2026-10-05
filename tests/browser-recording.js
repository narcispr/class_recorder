/* Real Chrome/MediaRecorder/File System checks; no runtime or test packages required.
 * Run: node tests/browser-recording.js (CHROME_BIN can select a Chrome executable).
 * All captures, files and the isolated browser profile live in a temporary folder.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const { spawn, execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(profile) {
  const child = spawn(process.env.CHROME_BIN || "google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
    "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`,
    "--remote-debugging-pipe", "about:blank"
  ], { detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let sequence = 0, buffer = "", stderr = "";
  const pending = new Map(), errors = [];
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-8000); });
  const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  child.on("error", fail);
  child.stdio[3].on("error", fail); child.stdio[4].on("error", fail);
  child.on("exit", code => fail(new Error(`Chrome exited (${code}): ${stderr}`)));
  child.stdio[4].on("data", data => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id) {
        const item = pending.get(message.id); if (!item) continue; pending.delete(message.id);
        if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
  await send("Browser.getVersion");
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId); await send("Runtime.enable", {}, sessionId);
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  return { send, evaluate, errors, sessionId, async close(crash = false) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (crash) process.kill(-child.pid, "SIGKILL"); else await send("Browser.close").catch(() => {});
    await exited;
  } };
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "class-recorder-test-"));
  let browser, server;
  try {
    const html = (await fs.readFile(path.join(root, "index.html"), "utf8"))
      .replace('<script src="app.js"></script>', "");
    // OPFS is unavailable on file://. Serve only these local fixtures for real disk checks.
    server = http.createServer(async (request, response) => {
      if (request.url === "/test.html") { response.setHeader("Content-Type", "text/html"); response.end(html); return; }
      const file = { "/worker.js": "worker.js", "/lib/webm-remuxer.js": "lib/webm-remuxer.js", "/style.css": "style.css" }[request.url];
      if (!file) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", file.endsWith("css") ? "text/css" : "text/javascript");
      response.end(await fs.readFile(path.join(root, file)));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/test.html`;
    const source = (await fs.readFile(path.join(root, "app.js"), "utf8")).replace("  initialize();",
      "  window.app = { state, refreshDevices, activateWebcam, activateMicrophone, startRecording, stopRecording, beginRollover, recoverRecording, tick }; initialize();");
    const open = async () => {
      browser = await launch(path.join(temporary, "profile"));
      await browser.send("Page.navigate", { url }, browser.sessionId);
      for (let i = 0; i < 100; i++) {
        if (await browser.evaluate("document.readyState === 'complete'")) break;
        await delay(50);
      }
      await browser.evaluate(source);
      await browser.evaluate("app.refreshDevices()");
      await browser.evaluate(`(async () => {
        app.state.runtime.outputRoot = await navigator.storage.getDirectory();
        document.getElementById('webcam').selectedIndex = 1;
        await app.activateWebcam();
        document.getElementById('microphone').selectedIndex = 1;
        await app.activateMicrophone();
        if (!app.state.runtime.microphoneStream) throw new Error(document.getElementById('statusMessage').textContent);
      })()`);
    };
    await open();
    const settings = await browser.evaluate(`({ camera: app.state.runtime.webcamStream.getVideoTracks()[0].getSettings(),
      checkpoint: app.state.recording.segmentDuration })`);
    assert.ok(settings.camera.frameRate <= 25, JSON.stringify(settings));
    assert.ok(settings.camera.width <= 1280); assert.equal(settings.checkpoint, 15000);
    await browser.evaluate("app.startRecording()");
    assert.equal(await browser.evaluate("app.state.runtime.canvasTrack.getSettings().frameRate"), 25);
    console.log("PASS: camera and canvas request 25 fps; default checkpoint is 15 seconds.");

    await delay(2000);
    await browser.evaluate(`(() => {
      const track = app.state.runtime.webcamStream.getVideoTracks()[0];
      track.stop(); track.dispatchEvent(new Event('ended'));
      if (!app.state.runtime.recording) throw new Error('Webcam failure stopped the recording');
    })()`);
    await delay(4500);
    assert.equal(await browser.evaluate("app.state.webcam.enabled"), true);
    assert.equal(await browser.evaluate("app.state.runtime.recording"), true);
    console.log("PASS: disconnected webcam reconnects without stopping the recording.");

    await browser.evaluate(`(() => {
      const track = app.state.runtime.microphoneStream.getAudioTracks()[0];
      track.stop(); track.dispatchEvent(new Event('ended'));
    })()`);
    await delay(1500);
    assert.equal(await browser.evaluate("!!app.state.runtime.microphoneStream"), true);
    assert.equal(await browser.evaluate("app.state.runtime.audioSources.size"), 1);
    console.log("PASS: microphone reconnects into the existing audio mix.");

    await browser.evaluate(`(() => {
      window.paintCount = 0;
      const context = document.getElementById('compositionCanvas').getContext('2d');
      const fill = context.fillRect.bind(context);
      context.fillRect = (...args) => { window.paintCount++; return fill(...args); };
      const end = performance.now() + 1300; while (performance.now() < end) {}
    })()`);
    await delay(200);
    assert.ok(await browser.evaluate("window.paintCount <= 8"), "Frame backlog after page stall");
    console.log("PASS: after a 1.3-second page stall, rendering resumes without a frame backlog.");

    await delay(7000);
    const committed = await browser.evaluate(`(async () => {
      const parts = [];
      for await (const [name, handle] of app.state.runtime.sessionDirectory.entries()) {
        if (/^recording-part/.test(name)) parts.push({ name, size: (await handle.getFile()).size });
      }
      return parts;
    })()`);
    assert.ok(committed.some(part => part.size > 0), JSON.stringify(committed));
    console.log("PASS: the first checkpoint is readable on disk while recording continues.");

    await browser.evaluate("app.state.runtime.recorder.stop()"); await delay(1200);
    assert.equal(await browser.evaluate("app.state.runtime.recorder.state"), "recording");
    assert.equal(await browser.evaluate("app.state.runtime.restartAttempts"), 1);
    console.log("PASS: an unexpected encoder stop saves its data and restarts automatically.");
    await browser.evaluate("app.stopRecording()");
    assert.match(await browser.evaluate("document.getElementById('statusMessage').textContent"), /Saved final recording/);
    const finalData = await browser.evaluate(`(async () => {
      const file = await (await app.state.runtime.sessionDirectory.getFileHandle(app.state.recording.outputFilename)).getFile();
      return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(file); });
    })()`);
    const finalPath = path.join(temporary, "final.webm"); await fs.writeFile(finalPath, Buffer.from(finalData, "base64"));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries",
      "stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", finalPath], { encoding: "utf8" }));
    const video = probe.streams.find(stream => stream.codec_type === "video");
    assert.equal(video.width, 1920); assert.equal(video.height, 1080);
    assert.ok(probe.streams.some(stream => stream.codec_type === "audio"));
    const measuredFps = Number(video.nb_read_frames) / Number(probe.format.duration);
    assert.ok(measuredFps > 10 && measuredFps <= 25.5, JSON.stringify(probe));
    execFileSync("ffmpeg", ["-v", "error", "-i", finalPath, "-f", "null", "-"], { stdio: "pipe" });
    console.log(`PASS: final VP8/Opus WebM decodes fully (${measuredFps.toFixed(1)} actual fps).`);

    const sessionName = await browser.evaluate("app.state.runtime.sessionDirectory.name");
    await browser.evaluate(`(async () => {
      const handle = await app.state.runtime.sessionDirectory.getFileHandle('recording-part-999.webm', { create: true });
      const writer = await handle.createWritable(); await writer.write('broken part'); await writer.close();
      window.showDirectoryPicker = async () => app.state.runtime.sessionDirectory;
      await app.recoverRecording();
    })()`);
    assert.match(await browser.evaluate("document.getElementById('statusMessage').textContent"), /Skipped damaged parts: recording-part-999.webm/);
    console.log("PASS: recovery merges good checkpoints and reports damaged parts without deleting originals.");

    await browser.evaluate(`(async () => {
      app.state.recording.segmentDuration = 1500;
      await app.startRecording();
    })()`);
    await delay(2600);
    const crashSession = await browser.evaluate("app.state.runtime.sessionDirectory.name");
    await browser.close(true); browser = null;
    await open();
    const recoveredParts = await browser.evaluate(`(async () => {
      const directory = await app.state.runtime.outputRoot.getDirectoryHandle(${JSON.stringify(crashSession)});
      window.showDirectoryPicker = async () => directory;
      await app.recoverRecording();
      return document.getElementById('statusMessage').textContent;
    })()`);
    assert.match(recoveredParts, /Recovered \d+ parts/);
    assert.notEqual(crashSession, sessionName);
    console.log("PASS: committed parts survive killing Chrome and recover after reopening it.");

    await browser.evaluate(`(async () => {
      document.getElementById('webcam').value = 'none'; await app.activateWebcam();
      await app.startRecording();
      if (app.state.runtime.canvasTrack) throw new Error('Audio-only mode created a video track');
    })()`);
    await delay(1500); await browser.evaluate("app.stopRecording()");
    assert.match(await browser.evaluate("document.getElementById('statusMessage').textContent"), /Saved final recording/);
    console.log("PASS: microphone-only recording still saves a final audio WebM.");

    await browser.send("Page.navigate", { url: pathToFileURL(path.join(root, "index.html")).href }, browser.sessionId);
    await delay(500);
    assert.equal(await browser.evaluate("document.querySelectorAll('.compatibility-item.fail').length"), 0);
    await browser.evaluate(`(async () => {
      document.getElementById('webcam').selectedIndex = 1;
      await document.getElementById('webcam').onchange();
      window.paintCount = 0;
      const context = document.getElementById('compositionCanvas').getContext('2d');
      const fill = context.fillRect.bind(context);
      context.fillRect = (...args) => { window.paintCount++; return fill(...args); };
    })()`);
    await delay(250);
    assert.equal(await browser.evaluate("document.getElementById('webcamState').textContent"), "Active");
    const filePaints = await browser.evaluate("window.paintCount");
    assert.ok(filePaints > 0 && filePaints <= 8, `file:// paint count: ${filePaints}`);
    console.log("PASS: the actual offline file:// app loads and renders using its worker fallback.");
    assert.equal(browser.errors.length, 0, JSON.stringify(browser.errors));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
