# Portable Class Recorder

A completely local, dependency-free Chrome application for producing a 1920×1080 course recording from a selected display, microphone, optional shared audio, and optional webcam.

Created by Narcís Palomeras.

## Use

1. Copy the whole folder to the USB drive and open index.html in current desktop Google Chrome on Windows.
2. Check the compatibility panel, choose an output folder, select a screen/window/tab, select a microphone, and select a webcam or None. Chrome requests the required device permissions.
3. Press REC. Chrome's native capture chooser controls which display and shared audio are available.
4. Press STOP. The app safely closes the current part and remuxes saved WebM parts into the final file in the session folder.

No web server, account, network request, CDN, installation, or runtime package is used.

## Recovery and output

Parts are written every five seconds to independent recording-part-###.webm files. A new recorder starts at the configured ten-minute checkpoint (change segmentDuration in app.js if needed). If Chrome or Windows stops, already closed parts remain playable in the session folder.

The final merge is local and does not re-encode video or audio. lib/webm-remuxer.js is project-local MIT-licensed code that copies VP8/Opus packet data, rebases WebM cluster timestamps, and writes duration and cue metadata. Temporary files are kept by default; select the deletion checkbox only when you have verified the final recording.

The Destination panel has five video-quality levels. Balanced is the default at 2.1 Mbps video plus 128 kbps audio (about 1.00 GB/hour at the configured bitrate), reduced from the original 3.5 Mbps video setting. Static slides can use less than these estimates.

## Notes

- The recording and preview use the exact same 1920×1080 canvas renderer.
- The worker supplies 25 fps render ticks and explicitly requests each canvas capture frame, so the recording does not depend on animation frames while the recorder tab is hidden.
- Device IDs and output folder handles are never written to portable profile files.
- Screen layout has independent left/right/top/bottom crop controls to remove captured projector margins.
- Text layout has independent X, Y, and scale controls for title, subtitle, and author.
- Save profile / layout includes the screen and webcam transforms/crops, text positions/scales, colors, quality, and metadata; Load profile / layout restores them.
- Shared/system audio depends on the Chrome chooser and the selected capture source. When it is unavailable, microphone-only recording continues.

## License

MIT. See LICENSE.
