// Where splats come from: the local server list, a static manifest, and the on-device cache.
// The cache stores the File/Blob itself, so even big .ply files are not copied into memory.

const DB_NAME = "roomsplat";
const STORE = "files";

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function cachePut(name, blob) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ name, blob }, "last");
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    return true;
  } catch (e) { console.warn("cache failed", e); return false; }
}

// Returns { name, blob } or null. Older versions stored raw bytes, which are wrapped into a Blob.
export async function cacheGet() {
  try {
    const db = await openDb();
    const rec = await new Promise((res) => {
      const r = db.transaction(STORE).objectStore(STORE).get("last");
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
    if (!rec) return null;
    if (rec.blob) return rec;
    if (rec.bytes) return { name: rec.name, blob: new Blob([rec.bytes]) };
    return null;
  } catch { return null; }
}

// Local server (server/serve.mjs) lists every splat in its folder at api/splats.
// On static hosting, an optional splats/index.json can list files instead.
export async function listRemoteSplats() {
  try {
    const r = await fetch("api/splats", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      const list = await r.json();
      return { source: "server", list };
    }
  } catch {}
  try {
    const r = await fetch("splats/index.json", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      const raw = await r.json();
      const list = raw.map((e) => (typeof e === "string" ? { name: e, url: "splats/" + e } : e));
      return { source: "manifest", list };
    }
  } catch {}
  return { source: "none", list: [] };
}

export function formatBytes(n) {
  if (!n && n !== 0) return "";
  if (n > 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(0) + " MB";
  return (n / 1e3).toFixed(0) + " kB";
}
