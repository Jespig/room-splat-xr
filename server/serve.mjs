#!/usr/bin/env node
// Local server for Room Splat XR. No dependencies, Node 18 or newer.
//
//   node server/serve.mjs                       serves the app and ./splats
//   node server/serve.mjs --splats "D:\Scans"   serves splats from any folder on this computer
//   node server/serve.mjs --port 9000
//
// The Quest reaches it over USB (or wireless adb) through "adb reverse", which makes the
// computer appear as http://localhost on the headset. localhost counts as a secure page,
// so WebXR works without certificates. Big .ply files are streamed straight from disk.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8080);
const SPLAT_DIR = path.resolve(args.splats || process.env.SPLAT_DIR || path.join(ROOT, "splats"));
const SPLAT_EXT = [".ply", ".spz", ".sog", ".splat", ".ksplat", ".zip", ".rad"];

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
  ".zip": "application/zip",
};

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v !== undefined ? v : (list[i + 1] && !list[i + 1].startsWith("--") ? list[++i] : true);
    }
  }
  return out;
}

// Resolve a URL path inside a base folder, refusing anything that escapes it.
function safeJoin(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const p = path.normalize(path.join(base, decoded));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

function listSplats() {
  if (!fs.existsSync(SPLAT_DIR)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      const r = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory() && rel.split("/").length < 3) walk(full, r);
      else if (ent.isFile() && SPLAT_EXT.includes(path.extname(ent.name).toLowerCase())) {
        const st = fs.statSync(full);
        out.push({ name: r, size: st.size, modified: st.mtimeMs, url: "splats/" + r.split("/").map(encodeURIComponent).join("/") });
      }
    }
  };
  walk(SPLAT_DIR, "");
  return out.sort((a, b) => b.modified - a.modified);
}

function sendFile(req, res, file, cacheable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheable ? "public, max-age=3600" : "no-store",
    };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); }

const server = http.createServer((req, res) => {
  // Allow the hosted (GitHub Pages) version to load splats from this computer too
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (p.split("/").some((seg) => seg.startsWith(".") || seg.startsWith("%2e") || seg.startsWith("%2E"))) return notFound(res); // no .git, .env etc.

  if (p === "/api/splats") {
    let list = [];
    try { list = listSplats(); } catch (e) { console.warn(e.message); }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(list));
  }

  if (p.startsWith("/splats/")) {
    const file = safeJoin(SPLAT_DIR, p.slice("/splats/".length));
    return file ? sendFile(req, res, file, true) : notFound(res);
  }

  let file = safeJoin(ROOT, p === "/" ? "index.html" : p.slice(1));
  if (!file) return notFound(res);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  sendFile(req, res, file, false); // app files are never cached, so edits show up on reload
});

// Keep "adb reverse" active so the Quest can open http://localhost:PORT (also after re-plugging)
let adbState = "";
function adbReverse() {
  execFile("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`], (err, stdout, stderr) => {
    let state;
    if (err && err.code === "ENOENT") state = "missing";
    else if (err) state = /no devices|not found|unauthorized/i.test(stderr + err.message) ? "nodevice" : "error";
    else state = "ok";
    if (state !== adbState) {
      adbState = state;
      if (state === "ok") log(`Quest connected: open  http://localhost:${PORT}  in the Quest browser`);
      if (state === "nodevice") log("Waiting for the Quest (USB cable, developer mode, allow USB debugging in the headset)...");
      if (state === "missing") log("adb not found. Install Android platform-tools to use the Quest over USB (see README).");
      if (state === "error") log("adb reverse failed: " + (stderr || err.message).trim());
    }
  });
}

function log(msg) { console.log("  " + msg); }

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

server.listen(PORT, () => {
  const splats = listSplats();
  console.log("");
  console.log("  Room Splat XR");
  log(`App:     http://localhost:${PORT}`);
  log(`Splats:  ${SPLAT_DIR}  (${splats.length} file${splats.length === 1 ? "" : "s"})`);
  for (const s of splats.slice(0, 8)) log(`         - ${s.name}  ${(s.size / 1e6).toFixed(0)} MB`);
  if (!fs.existsSync(SPLAT_DIR)) log("         (folder does not exist yet)");
  const lan = lanAddresses();
  if (lan.length) log(`LAN:     http://${lan[0]}:${PORT}  (works for preparing on another computer; the Quest needs USB/adb for WebXR)`);
  console.log("");
  if (!args["no-adb"]) { adbReverse(); setInterval(adbReverse, 5000); }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy. Try: node server/serve.mjs --port ${PORT + 1}`);
  else console.error(e);
  process.exit(1);
});
