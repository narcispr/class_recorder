/*
 * Small, dependency-free WebM/EBML remuxer (MIT license; project-local code).
 * It copies VP8/Opus packets unchanged, rebases Cluster timecodes, writes a
 * fresh Duration and Cues index, and deliberately never byte-concatenates
 * complete WebM documents.
 */
(function (root) {
  "use strict";

  const ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966,
    TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675, SEEK_HEAD: 0x114d9b74,
    CUES: 0x1c53bb6b, TAGS: 0x1254c367, ATTACHMENTS: 0x1941a469,
    CHAPTERS: 0x1043a770, TIMECODE: 0xe7, DURATION: 0x4489,
    TIMECODE_SCALE: 0x2ad7b1, SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0,
    BLOCK: 0xa1, TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7,
    CUE_POINT: 0xbb, CUE_TIME: 0xb3, CUE_TRACK_POSITIONS: 0xb7,
    CUE_TRACK: 0xf7, CUE_CLUSTER_POSITION: 0xf1
  };

  function bytesOf(value) { return value instanceof Uint8Array ? value : new Uint8Array(value); }
  function join(parts) {
    const size = parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(size); let at = 0;
    parts.forEach((part) => { out.set(part, at); at += part.length; });
    return out;
  }
  function raw(data, element) { return data.slice(element.start, element.end); }
  function idBytes(id) {
    const length = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) out[i] = Math.floor(id / 256 ** (length - 1 - i)) & 255;
    return out;
  }
  function readVint(data, at, keepMarker) {
    if (at >= data.length) throw new Error("Unexpected end of EBML data.");
    const first = data[at]; let length = 1; let marker = 0x80;
    while (length <= 8 && !(first & marker)) { marker >>= 1; length++; }
    if (length > 8 || at + length > data.length) throw new Error("Invalid EBML variable integer.");
    let value = keepMarker ? first : (first & (marker - 1));
    for (let i = 1; i < length; i++) value = value * 256 + data[at + i];
    let unknown = !keepMarker && first === (marker * 2 - 1);
    for (let i = 1; unknown && i < length; i++) unknown = data[at + i] === 255;
    return { length, value, unknown };
  }
  function readElement(data, at, limit) {
    const id = readVint(data, at, true); const size = readVint(data, at + id.length, false);
    const dataStart = at + id.length + size.length;
    const end = size.unknown ? limit : dataStart + size.value;
    if (end > limit || end < dataStart) throw new Error("Invalid EBML element length.");
    return { id: id.value, start: at, dataStart, end, size: size.value, unknown: size.unknown };
  }
  function children(data, start, end) {
    const result = []; let at = start;
    while (at < end) { const child = readElement(data, at, end); result.push(child); at = child.end; }
    return result;
  }
  /*
   * Chrome may emit unknown-sized Clusters in a live MediaRecorder stream.
   * An unknown-sized Cluster ends at the next Segment-level element, not at
   * the end of the Segment. Bound it here so each Cluster receives its own
   * timestamp when the parts are remuxed.
   */
  function unknownClusterEnd(data, start, end) {
    const topLevel = new Set([ID.CLUSTER, ID.SEEK_HEAD, ID.CUES, ID.INFO, ID.TRACKS, ID.TAGS, ID.ATTACHMENTS, ID.CHAPTERS]);
    let at = start;
    while (at < end) {
      const child = readElement(data, at, end);
      if (topLevel.has(child.id)) return at;
      at = child.end;
    }
    return end;
  }
  function segmentChildren(data, start, end) {
    const result = []; let at = start;
    while (at < end) {
      const child = readElement(data, at, end);
      if (child.id === ID.CLUSTER && child.unknown) child.end = unknownClusterEnd(data, child.dataStart, end);
      result.push(child);
      at = child.end;
    }
    return result;
  }
  function uint(data, start, end) {
    let value = 0;
    for (let i = start; i < end; i++) value = value * 256 + data[i];
    return value;
  }
  function signed16(data, at) { const n = (data[at] << 8) | data[at + 1]; return n & 0x8000 ? n - 0x10000 : n; }
  function floatValue(data, start, end) {
    const view = new DataView(data.buffer, data.byteOffset + start, end - start);
    return end - start === 4 ? view.getFloat32(0, false) : end - start === 8 ? view.getFloat64(0, false) : NaN;
  }
  function encodeVint(value) {
    for (let length = 1; length <= 8; length++) {
      if (value < 2 ** (7 * length) - 1) {
        const out = new Uint8Array(length);
        for (let i = length - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); }
        out[0] |= 1 << (8 - length);
        return out;
      }
    }
    throw new Error("EBML value is too large.");
  }
  function encodeUInt(value) {
    const length = Math.max(1, Math.ceil(Math.log2(Math.max(1, value) + 1) / 8));
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); }
    return out;
  }
  function element(id, payload) { return join([idBytes(id), encodeVint(payload.length), payload]); }
  function unknownSegmentSize() { return new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]); }

  function parseDocument(input) {
    const data = bytesOf(input); const top = children(data, 0, data.length);
    const segment = top.find((item) => item.id === ID.SEGMENT);
    if (!segment) throw new Error("The selected file is not a WebM segment.");
    const ebml = top.find((item) => item.id === ID.EBML);
    if (!ebml) throw new Error("The selected file has no EBML header.");
    return { data, ebml, segment, items: segmentChildren(data, segment.dataStart, segment.end) };
  }
  function sourceStats(document) {
    const clusters = document.items.filter((item) => item.id === ID.CLUSTER);
    if (!clusters.length) throw new Error("A recording segment contains no media clusters.");
    let first = Infinity, last = -Infinity;
    for (const cluster of clusters) {
      const stats = clusterStats(document.data, cluster);
      first = Math.min(first, stats.timecode);
      last = Math.max(last, stats.end);
    }
    const info = document.items.find((item) => item.id === ID.INFO);
    let declaredDuration = 0;
    if (info) for (const item of children(document.data, info.dataStart, info.end)) {
      if (item.id === ID.DURATION) declaredDuration = floatValue(document.data, item.dataStart, item.end) || 0;
    }
    return { clusters, first, duration: Math.max(1, last - first + 1, declaredDuration || 0) };
  }
  function clusterStats(data, cluster) {
    const items = children(data, cluster.dataStart, cluster.end);
    const time = items.find((item) => item.id === ID.TIMECODE);
    const timecode = time ? uint(data, time.dataStart, time.end) : 0;
    let end = timecode;
    const considerBlock = (block) => {
      const first = readVint(data, block.dataStart, false);
      const offsetAt = block.dataStart + first.length;
      if (offsetAt + 2 <= block.end) end = Math.max(end, timecode + signed16(data, offsetAt));
    };
    items.forEach((item) => {
      if (item.id === ID.SIMPLE_BLOCK) considerBlock(item);
      if (item.id === ID.BLOCK_GROUP) children(data, item.dataStart, item.end)
        .filter((nested) => nested.id === ID.BLOCK).forEach(considerBlock);
    });
    return { timecode, end };
  }
  function trackNumber(document) {
    const tracks = document.items.find((item) => item.id === ID.TRACKS);
    if (!tracks) return 1;
    const entry = children(document.data, tracks.dataStart, tracks.end).find((item) => item.id === ID.TRACK_ENTRY);
    if (!entry) return 1;
    const number = children(document.data, entry.dataStart, entry.end).find((item) => item.id === ID.TRACK_NUMBER);
    return number ? uint(document.data, number.dataStart, number.end) : 1;
  }
  function patchedInfo(data, info, duration) {
    const retained = children(data, info.dataStart, info.end).filter((item) => item.id !== ID.DURATION).map((item) => raw(data, item));
    const payload = new Uint8Array(8); new DataView(payload.buffer).setFloat64(0, duration, false);
    retained.push(element(ID.DURATION, payload));
    return element(ID.INFO, join(retained));
  }
  function header(document, duration) {
    const info = document.items.find((item) => item.id === ID.INFO);
    const keep = document.items.filter((item) => [ID.TRACKS, ID.TAGS, ID.ATTACHMENTS, ID.CHAPTERS].includes(item.id)).map((item) => raw(document.data, item));
    const infoData = info ? patchedInfo(document.data, info, duration) : element(ID.INFO, element(ID.DURATION, new Uint8Array(8)));
    const start = join([raw(document.data, document.ebml), idBytes(ID.SEGMENT), unknownSegmentSize(), infoData, ...keep]);
    return { bytes: start, segmentContentBytes: infoData.length + keep.reduce((n, item) => n + item.length, 0) };
  }
  function rebuiltCluster(data, cluster, sourceBase, offset) {
    const oldItems = children(data, cluster.dataStart, cluster.end);
    const oldTime = oldItems.find((item) => item.id === ID.TIMECODE);
    const sourceTime = oldTime ? uint(data, oldTime.dataStart, oldTime.end) : 0;
    const time = Math.max(0, Math.round(sourceTime - sourceBase + offset));
    const payload = [element(ID.TIMECODE, encodeUInt(time))];
    oldItems.filter((item) => item.id !== ID.TIMECODE).forEach((item) => payload.push(raw(data, item)));
    return { bytes: element(ID.CLUSTER, join(payload)), time };
  }
  function cue(time, track, position) {
    const trackPosition = element(ID.CUE_TRACK_POSITIONS, join([
      element(ID.CUE_TRACK, encodeUInt(track)), element(ID.CUE_CLUSTER_POSITION, encodeUInt(position))
    ]));
    return element(ID.CUE_POINT, join([element(ID.CUE_TIME, encodeUInt(time)), trackPosition]));
  }

  async function remuxFiles(files, writable, onProgress) {
    if (!files || !files.length) throw new Error("There are no completed recording segments to merge.");
    // First pass obtains an accurate final duration without holding all parts in memory.
    const descriptions = [];
    for (let index = 0; index < files.length; index++) {
      const document = parseDocument(await files[index].arrayBuffer());
      descriptions.push(sourceStats(document));
      if (onProgress) onProgress({ phase: "inspect", current: index + 1, total: files.length });
    }
    const totalDuration = descriptions.reduce((sum, part) => sum + part.duration, 0);
    const firstDocument = parseDocument(await files[0].arrayBuffer());
    const head = header(firstDocument, totalDuration);
    await writable.write(head.bytes);
    let position = head.segmentContentBytes;
    let timeline = 0;
    const cues = [];
    const selectedTrack = trackNumber(firstDocument);
    for (let index = 0; index < files.length; index++) {
      const document = index === 0 ? firstDocument : parseDocument(await files[index].arrayBuffer());
      const stats = descriptions[index];
      for (const cluster of stats.clusters) {
        const result = rebuiltCluster(document.data, cluster, stats.first, timeline);
        cues.push(cue(result.time, selectedTrack, position));
        await writable.write(result.bytes);
        position += result.bytes.length;
      }
      timeline += stats.duration;
      if (onProgress) onProgress({ phase: "write", current: index + 1, total: files.length });
    }
    await writable.write(element(ID.CUES, join(cues)));
    return { duration: totalDuration, segments: files.length };
  }

  root.WebmRemuxer = { remuxFiles };
})(typeof self !== "undefined" ? self : window);
