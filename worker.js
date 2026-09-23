/* Local timing worker. A worker continues to dispatch its timer while the page is hidden. */
let timer = null;
let frameInterval = 40;

self.onmessage = ({ data }) => {
  if (data.type === "start") {
    frameInterval = data.interval || 40;
    clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: "tick", now: performance.now() }), frameInterval);
  }
  if (data.type === "stop") {
    clearInterval(timer);
    timer = null;
  }
};
