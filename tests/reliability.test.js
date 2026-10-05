"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");

function appHarness({ failWrite = false, fastTimeout = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: "", value: "", style: {},
      classList: { toggle() {} }, getContext: () => ({}), getTracks: () => [] });
    return elements.get(id);
  };
  const writers = [];
  class Recorder {
    constructor() { this.state = "inactive"; this.listeners = new Map(); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || []; listeners.push(listener); this.listeners.set(type, listeners);
    }
    emit(type, event = {}) {
      this[`on${type}`]?.(event); for (const listener of this.listeners.get(type) || []) listener(event);
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      // Model the spec: inactive immediately, final data and stop arrive later.
      queueMicrotask(() => { this.emit("dataavailable", { data: { size: 4 } }); this.emit("stop"); });
    }
  }
  const directory = {
    async getFileHandle(name) {
      return { name, async getFile() { return { name }; }, async createWritable() {
        const writer = { writes: [], closed: false, aborted: false,
          async write(data) { if (failWrite) throw new Error("Disk disconnected"); this.writes.push(data); },
          async close() { this.closed = true; }, async abort() { this.aborted = true; } };
        writers.push(writer); return writer;
      } };
    }
  };
  const sandbox = { document: { getElementById: element, querySelectorAll: () => [] },
    performance, setTimeout, clearTimeout, MediaRecorder: Recorder,
    WebmRemuxer: { async remuxFiles(files, writer) { await writer.write(files); } } };
  let source = fs.readFileSync(path.join(root, "app.js"), "utf8").replace("  initialize();",
    "  globalThis.app = { state, startSegment, recorderStopped, finalise, beginRollover, stopRecording, withTimeout, updateRecordAvailability };");
  if (fastTimeout) source = source.replace("const STOP_TIMEOUT = 5000;", "const STOP_TIMEOUT = 5;");
  vm.runInNewContext(source, sandbox);
  const r = sandbox.app.state.runtime;
  Object.assign(r, { sessionDirectory: directory, compositionStream: { getTracks: () => [] },
    selectedMimeType: "video/webm;codecs=vp8", recording: true, sessionToken: {} });
  sandbox.app.state.recording.outputFilename = "final.webm";
  return { ...sandbox.app, writers, elements, Recorder };
}

test("the worker keeps at most one unacknowledged frame after a stall", () => {
  let interval, cleared = 0;
  const messages = [];
  const self = { postMessage: message => messages.push(message) };
  vm.runInNewContext(fs.readFileSync(path.join(root, "worker.js"), "utf8"), {
    self, setInterval: callback => { interval = callback; return 1; }, clearInterval: () => cleared++
  });
  self.onmessage({ data: { type: "start", interval: 40 } });
  for (let i = 0; i < 1000; i++) interval();
  assert.equal(messages.length, 1);
  self.onmessage({ data: { type: "ack" } }); interval();
  assert.equal(messages.length, 2);
  self.onmessage({ data: { type: "stop" } }); assert.equal(cleared, 2);
});

test("an inactive encoder's queued final data is written before closing", async () => {
  const app = appHarness(); const segment = await app.startSegment();
  segment.recorder.stop();
  await app.recorderStopped(segment); await app.finalise(segment);
  assert.equal(app.writers[0].writes.length, 1);
  assert.equal(app.writers[0].closed, true);
  assert.equal(app.state.runtime.completedSegments.length, 1);
  assert.equal(app.state.runtime.pendingBytes, 0);
});

test("unexpected encoder stops restart with unique checkpoint filenames", async () => {
  const app = appHarness(); const first = await app.startSegment();
  first.recorder.stop();
  await new Promise(resolve => setTimeout(resolve, 10));
  if (app.state.runtime.rolloverPromise) await app.state.runtime.rolloverPromise;
  assert.equal(app.state.runtime.recording, true);
  assert.equal(app.state.runtime.currentSegment.name, "recording-part-002.webm");
  assert.equal(app.writers[0].closed, true);
  assert.equal(app.state.runtime.completedSegments.length, 1);
});

test("STOP during rollover finishes the last checkpoint without deadlocking", async () => {
  const app = appHarness(); await app.startSegment();
  app.beginRollover(); await app.stopRecording();
  assert.equal(app.state.runtime.stopping, false);
  assert.equal(app.state.runtime.recording, false);
  assert.equal(app.state.runtime.currentSegment, null);
  assert.equal(app.writers.filter(writer => writer.closed).length, 2); // checkpoint and final
  assert.match(app.elements.get("statusMessage").textContent, /Saved final recording/);
});

test("write failures abort the broken checkpoint and surface the error", async () => {
  const app = appHarness({ failWrite: true }); const segment = await app.startSegment();
  segment.recorder.emit("dataavailable", { data: { size: 4 } });
  await segment.queue;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.state.runtime.recording, false);
  assert.equal(app.state.runtime.saveError.message, "Disk disconnected");
  assert.equal(app.state.runtime.completedSegments.length, 0);
  assert.equal(app.writers[0].aborted, true);
  assert.equal(app.state.runtime.pendingBytes, 0);
  assert.match(app.elements.get("statusMessage").textContent, /Completed segment files were kept/);
});

test("a slow writer cannot accumulate more than 32 MB of queued video", async () => {
  const app = appHarness(); const segment = await app.startSegment();
  const oversized = { size: 33 * 1024 * 1024 };
  segment.recorder.emit("dataavailable", { data: oversized });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.state.runtime.recording, false);
  assert.equal(app.state.runtime.pendingBytes, 0);
  assert.match(app.state.runtime.saveError.message, /32 MB/);
  assert.equal(app.writers[0].writes.length, 0);
});

test("a hung operation times out and does not leave a pending timer", async () => {
  const app = appHarness();
  await assert.rejects(app.withTimeout(new Promise(() => {}), 5, "Timed out"), /Timed out/);
  assert.equal(await app.withTimeout(Promise.resolve(42), 5, "Unused"), 42);
});

test("an encoder that never delivers stop is abandoned and replaced", async () => {
  const app = appHarness({ fastTimeout: true }); const segment = await app.startSegment();
  segment.recorder.stop = () => { segment.recorder.state = "inactive"; };
  app.beginRollover(); await app.state.runtime.rolloverPromise;
  assert.equal(segment.abandoned, true);
  assert.equal(app.writers[0].aborted, true);
  assert.equal(app.state.runtime.recording, true);
  assert.equal(app.state.runtime.currentSegment.name, "recording-part-002.webm");
});

test("repeated encoder failures stop safely rather than retrying forever", async () => {
  const app = appHarness(); await app.startSegment();
  for (let i = 0; i < 4; i++) {
    app.beginRollover("Encoder failed"); await app.state.runtime.rolloverPromise;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.state.runtime.recording, false);
  assert.equal(app.state.runtime.stopping, false);
  assert.equal(app.state.runtime.completedSegments.length, 4);
  assert.match(app.elements.get("statusMessage").textContent, /Encoder failed repeatedly/);
});
