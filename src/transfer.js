// Send the splat from the computer to the headset, browser to browser (WebRTC via PeerJS).
// The computer opens a "sender" while the QR window is open; the QR link carries its id (#s=...).
// The headset connects and receives the file directly. Only the connection setup goes through
// the public PeerJS server; the file itself travels peer to peer (encrypted), usually inside your Wi-Fi.

const PEER_URL = "https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm";
const CHUNK = 64 * 1024;            // size of one data channel message
const READ = 4 * 1024 * 1024;       // bytes read from the file at a time
const MAX_BUFFERED = 8 * 1024 * 1024;

let PeerClass = null;
async function loadPeer() {
  if (!PeerClass) {
    const m = await import(PEER_URL);
    PeerClass = m.Peer || m.default;
  }
  return PeerClass;
}

function randomId(n = 10) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Computer side. getFile() returns { blob, name }. onStatus({ state, progress, error }).
export async function startSender({ getFile, onStatus }) {
  const Peer = await loadPeer();
  const id = "rsx-" + randomId();
  const peer = new Peer(id, { debug: 0 });
  let closed = false;
  await new Promise((res, rej) => { peer.once("open", res); peer.once("error", rej); });

  peer.on("connection", (conn) => {
    conn.on("data", async (msg) => {
      if (typeof msg !== "string") return;
      let m; try { m = JSON.parse(msg); } catch { return; }
      if (m.t !== "hello") return;
      try {
        onStatus({ state: "connected" });
        const { blob, name } = await getFile();
        conn.send(JSON.stringify({ t: "meta", name, size: blob.size }));
        let sent = 0;
        while (sent < blob.size) {
          const end = Math.min(sent + READ, blob.size);
          const buf = await blob.slice(sent, end).arrayBuffer();
          for (let o = 0; o < buf.byteLength; o += CHUNK) {
            if (closed || !conn.open) throw new Error("Connection closed");
            while (conn.dataChannel && conn.dataChannel.bufferedAmount > MAX_BUFFERED) await sleep(8);
            conn.send(buf.slice(o, o + CHUNK));
          }
          sent = end;
          onStatus({ state: "sending", progress: sent / blob.size });
        }
        conn.send(JSON.stringify({ t: "end" }));
        onStatus({ state: "done" });
      } catch (e) {
        onStatus({ state: "error", error: e.message || String(e) });
        try { conn.send(JSON.stringify({ t: "error", error: e.message || String(e) })); } catch {}
      }
    });
  });
  peer.on("error", (e) => { if (!closed) onStatus({ state: "error", error: e.type || e.message }); });

  return { id, close() { closed = true; try { peer.destroy(); } catch {} } };
}

// Headset side. Resolves with { blob, name }. onStatus({ step, name, size, progress }).
// Errors carry a "step" so the page can say exactly where it stopped.
function stepError(step, err) {
  const msg = err?.type ? `${err.type}${err.message ? ": " + err.message : ""}` : (err?.message || String(err));
  const e = new Error(msg); e.step = step; return e;
}

export async function receiveSplat(id, onStatus) {
  onStatus({ step: 1 });
  let Peer;
  try { Peer = await loadPeer(); } catch (err) { throw stepError(1, err); }

  onStatus({ step: 2 });
  const peer = new Peer({ debug: 1 });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("no answer from the PeerJS server")), 15000);
      peer.once("open", () => { clearTimeout(t); res(); });
      peer.once("error", (e) => { clearTimeout(t); rej(e); });
    });
  } catch (err) { try { peer.destroy(); } catch {} throw stepError(2, err); }

  // Step 3: reach the computer. Retries a few times, the computer may still be getting ready.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    onStatus({ step: 3, attempt });
    try {
      const result = await receiveOnce(peer, id, onStatus);
      setTimeout(() => { try { peer.destroy(); } catch {} }, 500);
      return result;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await sleep(1500);
    }
  }
  try { peer.destroy(); } catch {}
  throw lastErr;
}

function receiveOnce(peer, id, onStatus) {
  return new Promise((resolve, reject) => {
    let meta = null, parts = [], partBytes = 0, blobs = [], got = 0, done = false, timer = null;
    const finish = (err, value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      peer.off("error", onPeerError);
      err ? reject(err) : resolve(value);
    };
    const onPeerError = (e) => {
      const err = stepError(meta ? 4 : 3, e);
      if (e?.type === "peer-unavailable") err.message = "the computer is not reachable (peer-unavailable). Is the QR window still open on the Mac?";
      finish(err);
    };
    timer = setTimeout(() => finish(stepError(3, new Error("timeout: no connection to the computer after 25 s (different networks or a firewall?)"))), 25000);
    peer.on("error", onPeerError);

    const conn = peer.connect(id, { serialization: "raw", reliable: true });
    conn.on("open", () => conn.send(JSON.stringify({ t: "hello" })));
    conn.on("data", (d) => {
      if (typeof d === "string") {
        let m; try { m = JSON.parse(d); } catch { return; }
        if (m.t === "meta") { meta = m; clearTimeout(timer); onStatus({ step: 4, name: m.name, size: m.size, progress: 0 }); }
        else if (m.t === "error") { const e = stepError(4, new Error("computer: " + m.error)); e.fatal = true; finish(e); }
        else if (m.t === "end") {
          if (parts.length) blobs.push(new Blob(parts));
          const blob = new Blob(blobs);
          if (meta && blob.size !== meta.size) { const e = stepError(4, new Error(`transfer incomplete (${blob.size} of ${meta.size} bytes)`)); e.fatal = true; finish(e); }
          else finish(null, { blob, name: meta ? meta.name : "splat.ply" });
        }
        return;
      }
      const size = d.byteLength ?? d.size ?? 0;
      parts.push(d); partBytes += size; got += size;
      // Group pieces into bigger blobs so the browser can move them out of memory
      if (partBytes > 32 * 1024 * 1024) { blobs.push(new Blob(parts)); parts = []; partBytes = 0; }
      if (meta) onStatus({ step: 4, name: meta.name, size: meta.size, progress: got / meta.size });
    });
    conn.on("error", (e) => finish(stepError(meta ? 4 : 3, e)));
    conn.on("close", () => { const e = stepError(meta ? 4 : 3, new Error("connection closed")); if (meta) e.fatal = true; finish(e); });
  });
}
