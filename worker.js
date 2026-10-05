/* One outstanding tick at a time: a busy page drops frames instead of building a backlog. */
function timingWorker() {
  let timer = null;
  let waiting = false;
  self.onmessage = ({ data }) => {
    if (data.type === "ack") waiting = false;
    if (data.type === "start") {
      clearInterval(timer);
      waiting = false;
      timer = setInterval(() => {
        if (waiting) return;
        waiting = true;
        self.postMessage({ type: "tick" });
      }, data.interval || 40);
    }
    if (data.type === "stop") {
      clearInterval(timer);
      timer = null;
      waiting = false;
    }
  };
}

// The same implementation supplies the file:// fallback, avoiding two different clocks.
if (typeof document === "undefined") timingWorker();
