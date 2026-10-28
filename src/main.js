import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { Hud } from "./hud.js";
import { cachePut, cacheGet, listRemoteSplats, formatBytes } from "./sources.js";

/* ---------------------------------------------------------------
   Constants and state
---------------------------------------------------------------- */
export const APP_VERSION = "0.3.1";
const LS_PREP = "roomsplat.prep.v1";
const LS_CALIB = "roomsplat.calib.v1";
const LS_LAST = "roomsplat.last.v1";
const AUTO_FILES = ["room.spz", "room.sog", "room.ply", "room.splat", "room.ksplat"];
const STREAM_ABOVE = 300 * 1024 * 1024; // files larger than this are streamed instead of read into memory at once
const UP = new THREE.Vector3(0, 1, 0);
const ORIENT = {
  ydown: new THREE.Quaternion(1, 0, 0, 0),                                              // 180 deg about X (OpenCV style files)
  yup: new THREE.Quaternion(),
  zup: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
};
const GHOST_OPACITY = 0.45;

const $ = (id) => document.getElementById(id);
const ui = {
  file: $("file"), remember: $("remember"), status: $("status"), prog: $("prog"),
  serverBox: $("serverBox"), serverList: $("serverList"), loadServer: $("loadServer"), refreshServer: $("refreshServer"),
  urlInput: $("urlInput"), loadUrl: $("loadUrl"),
  orient: $("orient"), pickCorner: $("pickCorner"), pickWall: $("pickWall"),
  pickMeasure: $("pickMeasure"), realDist: $("realDist"), applyScale: $("applyScale"), measure: $("measure"),
  frame: $("frame"), resetPrep: $("resetPrep"), copyLink: $("copyLink"), showQr: $("showQr"),
  qrModal: $("qrModal"), qrCanvas: $("qrCanvas"), qrUrl: $("qrUrl"), qrCopy: $("qrCopy"), qrClose: $("qrClose"),
  qrShort: $("qrShort"), qrWithRef: $("qrWithRef"),
  quality: $("quality"), detail: $("detail"), enter: $("enter"), xrmsg: $("xrmsg"), clearCalib: $("clearCalib"),
  panel: $("ui"), toggleUi: $("toggleUi"), pickHint: $("pickHint"), version: $("version"),
};

let splat = null;          // SplatMesh
let splatName = "";
let prep = defaultPrep();  // reference points in raw splat-file coordinates
let pickMode = null;       // 'corner' | 'wall' | 'm1' | 'm2'
let xrSupport = { ar: false, vr: false };
let remote = { source: "none", list: [] };
let loadToken = 0;

function defaultPrep() {
  return { orient: "ydown", scale: 1, corner: null, wall: null, m1: null, m2: null, file: "" };
}

/* ---------------------------------------------------------------
   Renderer, scene, Spark
---------------------------------------------------------------- */
const canvas = $("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;

const DESKTOP_BG = new THREE.Color(0x111316);
const scene = new THREE.Scene();
scene.background = DESKTOP_BG;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 500);
camera.position.set(4, 4, 6);

const spark = new SparkRenderer({ renderer, maxStdDev: Math.sqrt(5) });
scene.add(spark);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(0, 1, 0);

// worldRoot = headset calibration (where the room origin is in real space)
// prepGroup = reference prep (moves the picked corner to the origin, wall along +X, floor at y = 0)
const worldRoot = new THREE.Group();
const prepGroup = new THREE.Group();
worldRoot.add(prepGroup);
scene.add(worldRoot);

// Desktop helpers
const desktopOnly = new THREE.Group();
desktopOnly.add(new THREE.GridHelper(20, 20, 0x4a5260, 0x2a2f37));
scene.add(desktopOnly);

// Origin guide: vertical post at the corner plus a line along the wall (+X). Lives inside worldRoot.
const guideMat = new THREE.MeshBasicMaterial({ color: 0xc6ff3d, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
const guideMat2 = new THREE.MeshBasicMaterial({ color: 0x4fd8ff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
const cornerGuide = new THREE.Group();
{
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 2.2, 8), guideMat);
  post.position.y = 1.1;
  const axis = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.008, 0.008), guideMat2);
  axis.position.set(0.75, 0.004, 0);
  const tipCone = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 12), guideMat2);
  tipCone.rotation.z = -Math.PI / 2;
  tipCone.position.set(1.52, 0.004, 0);
  [post, axis, tipCone].forEach((m) => { m.renderOrder = 900; cornerGuide.add(m); });
}
worldRoot.add(cornerGuide);

// Desktop pick markers (world space, recomputed from local coordinates)
function markerMesh(color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 20, 14),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
  m.renderOrder = 950; m.visible = false; desktopOnly.add(m); return m;
}
const markers = { corner: markerMesh(0xc6ff3d), wall: markerMesh(0x4fd8ff), m1: markerMesh(0xffb347), m2: markerMesh(0xffb347) };
const measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true }));
measureLine.renderOrder = 950; measureLine.visible = false; desktopOnly.add(measureLine);

// Void sphere: black surroundings that hide passthrough in "Void" view
const voidSphere = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false }));
voidSphere.renderOrder = -1000; voidSphere.visible = false;
scene.add(voidSphere);

const hud = new Hud(scene, camera);
const _v1 = new THREE.Vector3(), _v3 = new THREE.Vector3();

/* ---------------------------------------------------------------
   UI helpers
---------------------------------------------------------------- */
function setStatus(text, cls = "") { ui.status.textContent = text; ui.status.className = "status " + cls; }
function setProgress(f) { ui.prog.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`; }
function showPickHint(text) { ui.pickHint.textContent = text; ui.pickHint.style.display = text ? "block" : "none"; }
const fmt = (v, d = 2) => Number(v).toFixed(d);

ui.toggleUi.onclick = () => ui.panel.classList.toggle("hidden");
ui.version.textContent = `v${APP_VERSION}`;

/* ---------------------------------------------------------------
   Prep persistence (localStorage + URL hash)
---------------------------------------------------------------- */
const r5 = (a) => a && a.map((v) => Math.round(v * 1e5) / 1e5);

// Compact link format, keeps the QR code small and easy to scan:
//   #p=<orient>.<scale>.<corner x.y.z>.<wall x.y.z>.<file id>   numbers in base 36, 0.1 mm steps
const enc36 = (v, k) => Math.round(v * k).toString(36);
const dec36 = (t, k) => parseInt(t, 36) / k;
const ORIENT_CODE = { ydown: "d", yup: "u", zup: "z" };
function fileHash(name) {
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (h % 1679616).toString(36); // at most 4 characters
}

function encodePrep() {
  const pts = (a) => (a ? a.map((v) => enc36(v, 1e4)).join(".") : "_._._");
  return [ORIENT_CODE[prep.orient] || "d", enc36(prep.scale, 1e5), pts(prep.corner), pts(prep.wall), prep.file ? fileHash(prep.file) : "_"].join(".");
}

function decodePrep(code) {
  const t = code.split(".");
  if (t.length !== 9) return null;
  const orient = Object.keys(ORIENT_CODE).find((k) => ORIENT_CODE[k] === t[0]) || "ydown";
  const pt = (i) => (t[i] === "_" ? null : [dec36(t[i], 1e4), dec36(t[i + 1], 1e4), dec36(t[i + 2], 1e4)]);
  const scale = dec36(t[1], 1e5);
  return { orient, scale: scale > 0 ? scale : 1, corner: pt(2), wall: pt(5), fileHash: t[8] === "_" ? "" : t[8] };
}

function loadPrep() {
  // 1. Compact link (#p=...), 2. older long link (#prep=...), 3. this device
  const mp = location.hash.match(/[#&]p=([^&]+)/);
  if (mp) {
    const d = decodePrep(decodeURIComponent(mp[1]));
    if (d) { Object.assign(prep, d, { file: "" }); return; }
  }
  let raw = null;
  const m = location.hash.match(/prep=([^&]+)/);
  if (m) { try { raw = JSON.parse(decodeURIComponent(m[1])); } catch {} }
  if (!raw) { try { raw = JSON.parse(localStorage.getItem(LS_PREP)); } catch {} }
  if (!raw) return;
  prep.orient = ORIENT[raw.o] ? raw.o : "ydown";
  prep.scale = raw.s > 0 ? raw.s : 1;
  prep.corner = raw.c || null;
  prep.wall = raw.w || null;
  prep.file = raw.f || "";
}

function savePrep() {
  const p = { o: prep.orient, s: Math.round(prep.scale * 1e5) / 1e5, c: r5(prep.corner), w: r5(prep.wall), f: prep.file };
  try { localStorage.setItem(LS_PREP, JSON.stringify(p)); } catch {}
  history.replaceState(null, "", location.pathname + location.search + "#p=" + encodePrep());
}

/* ---------------------------------------------------------------
   Apply prep: orientation, scale, corner to origin, wall along +X
---------------------------------------------------------------- */
function orientedPoint(arr) {
  return new THREE.Vector3().fromArray(arr).applyQuaternion(ORIENT[prep.orient]).multiplyScalar(prep.scale);
}

function applyPrep(save = true) {
  if (!splat) return;
  splat.quaternion.copy(ORIENT[prep.orient]);
  splat.scale.setScalar(prep.scale);
  splat.position.set(0, 0, 0);
  prepGroup.position.set(0, 0, 0);
  prepGroup.quaternion.identity();

  if (prep.corner) {
    const o = orientedPoint(prep.corner);
    let phi = 0;
    if (prep.wall) {
      const w = orientedPoint(prep.wall);
      const dx = w.x - o.x, dz = w.z - o.z;
      if (Math.hypot(dx, dz) > 1e-4) phi = Math.atan2(dz, dx); // rotates the wall direction onto +X
    }
    prepGroup.quaternion.setFromAxisAngle(UP, phi);
    prepGroup.position.copy(o).applyQuaternion(prepGroup.quaternion).negate();
  }
  scene.updateMatrixWorld(true);
  updateMarkers();
  updateInfo();
  updatePickButtons();
  if (save) savePrep();
}

function updateMarkers() {
  for (const key of ["corner", "wall", "m1", "m2"]) {
    const mk = markers[key];
    if (splat && prep[key]) { mk.position.copy(splat.localToWorld(new THREE.Vector3().fromArray(prep[key]))); mk.visible = true; }
    else mk.visible = false;
  }
  if (markers.m1.visible && markers.m2.visible) {
    measureLine.geometry.setFromPoints([markers.m1.position, markers.m2.position]);
    measureLine.visible = true;
  } else measureLine.visible = false;

  const raw = rawMeasure();
  if (raw) {
    ui.measure.innerHTML = `Measured: <b>${fmt(raw * prep.scale, 3)} m</b> at current scale ${fmt(prep.scale, 4)}. Enter the real distance and press Set scale.`;
    ui.applyScale.disabled = false;
  } else ui.applyScale.disabled = true;
}

function rawMeasure() {
  if (!prep.m1 || !prep.m2) return 0;
  return new THREE.Vector3().fromArray(prep.m1).distanceTo(new THREE.Vector3().fromArray(prep.m2));
}

function updateInfo() {
  if (!splat || !splat.isInitialized) return;
  let sizeTxt = "";
  try {
    const box = splat.getBoundingBox(true).clone();
    box.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(), ORIENT[prep.orient], new THREE.Vector3().setScalar(prep.scale)));
    const s = box.getSize(new THREE.Vector3());
    sizeTxt = `\nSize: ${fmt(s.x, 1)} x ${fmt(s.y, 1)} (height) x ${fmt(s.z, 1)} m`;
  } catch {}
  const n = splat.numSplats || 0;
  const heavy = n > 1500000 ? "\nLarge scan: a level-of-detail version is used in the headset." : "";
  const refTxt = prep.corner ? (prep.wall ? "\nReference: corner and wall set." : "\nReference: corner set, wall missing.") : "\nReference: not set yet.";
  setStatus(`${splatName}\n${n.toLocaleString()} splats${sizeTxt}${heavy}${refTxt}`, "ok");
}

/* ---------------------------------------------------------------
   Loading splats
   Sources: local server list, pasted URL, ?splat= param, file picker, on-device cache
---------------------------------------------------------------- */
const nameFromUrl = (u) => decodeURIComponent(u.split("?")[0].split("/").pop() || "splat");
function saveLast(v) { try { localStorage.setItem(LS_LAST, JSON.stringify(v)); } catch {} }
function loadLast() { try { return JSON.parse(localStorage.getItem(LS_LAST)); } catch { return null; } }

async function loadSplat({ url, blob, name }) {
  const token = ++loadToken;
  if (splat) { prepGroup.remove(splat); try { splat.dispose(); } catch {} splat = null; }
  splatName = name;
  const sizeTxt = blob ? ` (${formatBytes(blob.size)})` : "";
  setStatus(`Loading ${name}${sizeTxt}...`);
  setProgress(0.02);
  updateEnterButton();
  updatePickButtons();

  // A different file than the one the reference was made for: keep orientation, reset the rest
  const otherFile = prep.file ? prep.file !== name : !!(prep.fileHash && prep.fileHash !== fileHash(name));
  if (otherFile) {
    const o = prep.orient; prep = defaultPrep(); prep.orient = o;
  }
  prep.file = name;
  prep.fileHash = "";
  ui.orient.value = prep.orient;

  const opts = {
    lod: true, lodAbove: 1000000, // big scans get a level-of-detail tree that fits the Quest budget
    onProgress: (e) => { if (token === loadToken && e && e.total) setProgress(e.loaded / e.total); },
  };

  try {
    if (blob) {
      opts.fileName = name;
      if (blob.size > STREAM_ABOVE) { opts.stream = blob.stream(); opts.streamLength = blob.size; }
      else opts.fileBytes = await blob.arrayBuffer();
    } else opts.url = url;

    const mesh = new SplatMesh(opts);
    splat = mesh;
    prepGroup.add(mesh);
    await mesh.initialized;
    if (token !== loadToken) return; // a newer load started meanwhile
    setProgress(1);
    applyPrep();
    frameView();
    setTimeout(() => setProgress(0), 600);
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    setStatus(`Could not load ${name}.\n${err?.message || err}`, "err");
    setProgress(0);
    if (splat) { prepGroup.remove(splat); splat = null; }
  }
  updateEnterButton();
  updatePickButtons();
}

// File picker. The File itself goes into the cache (stored on disk, not copied into memory).
ui.file.addEventListener("change", async () => {
  const f = ui.file.files?.[0];
  if (!f) return;
  ui.file.value = "";
  if (ui.remember.checked) {
    const ok = await cachePut(f.name, f);
    saveLast(ok ? { type: "cache" } : null);
  }
  loadSplat({ blob: f, name: f.name });
});

// Pasted URL
function loadFromUrl(url) {
  url = url.trim();
  if (!url) return;
  saveLast({ type: "url", url, name: nameFromUrl(url) });
  loadSplat({ url, name: nameFromUrl(url) });
}
ui.loadUrl.onclick = () => loadFromUrl(ui.urlInput.value);
ui.urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromUrl(ui.urlInput.value); });

// Local server list
async function refreshRemote() {
  remote = await listRemoteSplats();
  ui.serverList.innerHTML = "";
  for (const s of remote.list) {
    const opt = document.createElement("option");
    opt.value = s.url;
    opt.textContent = s.size ? `${s.name}  (${formatBytes(s.size)})` : s.name;
    ui.serverList.appendChild(opt);
  }
  if (remote.source === "server" && !remote.list.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "Folder is empty"; ui.serverList.appendChild(opt);
  }
  ui.serverBox.classList.toggle("hidden", remote.source === "none");
  ui.serverBox.querySelector("label").textContent = remote.source === "server" ? "On computer" : "Available";
  const last = loadLast();
  if (last?.type === "url" && remote.list.some((s) => s.url === last.url)) ui.serverList.value = last.url;
}
ui.refreshServer.onclick = refreshRemote;
ui.loadServer.onclick = () => {
  const url = ui.serverList.value;
  if (!url) return;
  const entry = remote.list.find((s) => s.url === url);
  saveLast({ type: "url", url, name: entry?.name || nameFromUrl(url) });
  loadSplat({ url, name: entry?.name || nameFromUrl(url) });
};

async function autoLoad() {
  await refreshRemote();

  const param = new URLSearchParams(location.search).get("splat");
  if (param) return loadSplat({ url: param, name: nameFromUrl(param) });

  const last = loadLast();
  if (last?.type === "url" && last.url) return loadSplat({ url: last.url, name: last.name || nameFromUrl(last.url) });

  const cached = await cacheGet();
  if (cached?.blob) return loadSplat({ blob: cached.blob, name: cached.name });

  if (remote.list.length === 1) {
    const s = remote.list[0];
    return loadSplat({ url: s.url, name: s.name });
  }
  if (!remote.list.length && location.protocol.startsWith("http")) {
    for (const f of AUTO_FILES) {
      try {
        const r = await fetch(f, { method: "HEAD", cache: "no-store" });
        const type = r.headers.get("content-type") || "";
        if (r.ok && !type.includes("text/html")) return loadSplat({ url: f, name: f });
      } catch {}
    }
  }
  setStatus(remote.list.length ? "Choose a splat from the list above." : "No splat loaded. Choose a file above.");
}

/* ---------------------------------------------------------------
   Desktop picking
---------------------------------------------------------------- */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downPos = null;

const PICK_TEXT = {
  corner: "Click the room corner where it meets the floor",
  wall: "Click a floor point along one wall of that corner (1.5 m or more away)",
  m1: "Measure: click the first point",
  m2: "Measure: click the second point",
};

function setPickMode(mode) {
  pickMode = mode;
  canvas.classList.toggle("picking", !!mode);
  showPickHint(mode ? PICK_TEXT[mode] + "  (Esc to cancel)" : "");
  updatePickButtons();
}
function updatePickButtons() {
  ui.pickCorner.classList.toggle("active", pickMode === "corner");
  ui.pickWall.classList.toggle("active", pickMode === "wall");
  ui.pickMeasure.classList.toggle("active", pickMode === "m1" || pickMode === "m2");
  const has = !!(splat && splat.isInitialized);
  ui.pickCorner.disabled = !has; ui.pickWall.disabled = !has || !prep.corner; ui.pickMeasure.disabled = !has;
}

ui.pickCorner.onclick = () => setPickMode(pickMode === "corner" ? null : "corner");
ui.pickWall.onclick = () => setPickMode(pickMode === "wall" ? null : "wall");
ui.pickMeasure.onclick = () => {
  if (pickMode === "m1" || pickMode === "m2") return setPickMode(null);
  prep.m1 = prep.m2 = null; updateMarkers(); setPickMode("m1");
};
window.addEventListener("keydown", (e) => { if (e.key === "Escape") { setPickMode(null); ui.qrModal.classList.add("hidden"); } });

canvas.addEventListener("pointerdown", (e) => { downPos = [e.clientX, e.clientY]; });
canvas.addEventListener("pointerup", (e) => {
  if (!pickMode || !splat || !downPos) return;
  if (Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]) > 6) return; // that was an orbit drag
  const p = pickAt(e);
  if (!p) { showPickHint("Nothing hit there. Try again, or Esc to cancel."); return; }
  if (pickMode === "corner") {
    prep.corner = p;
    applyPrep();
    setPickMode(prep.wall ? null : "wall");
  } else if (pickMode === "wall") {
    const o = orientedPoint(prep.corner), w = orientedPoint(p);
    if (Math.hypot(w.x - o.x, w.z - o.z) < 0.5) { showPickHint("Too close to the corner. Pick a point further along the wall."); return; }
    prep.wall = p;
    applyPrep();
    setPickMode(null);
    frameView();
  } else if (pickMode === "m1") {
    prep.m1 = p; updateMarkers(); setPickMode("m2");
  } else if (pickMode === "m2") {
    prep.m2 = p; updateMarkers(); setPickMode(null); ui.realDist.focus();
  }
});

function pickAt(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  let hits = [];
  try { hits = raycaster.intersectObject(splat, false); } catch (err) { console.warn(err); }
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  return splat.worldToLocal(hits[0].point.clone()).toArray();
}

ui.applyScale.onclick = () => {
  const real = parseFloat(ui.realDist.value);
  const raw = rawMeasure();
  if (!(real > 0) || !raw) return;
  prep.scale = real / raw;
  applyPrep();
};

ui.orient.onchange = () => { prep.orient = ui.orient.value; applyPrep(); frameView(); };
ui.resetPrep.onclick = () => {
  const f = prep.file; prep = defaultPrep(); prep.file = f; ui.orient.value = prep.orient;
  setPickMode(null); applyPrep(); frameView();
};
ui.copyLink.onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); ui.copyLink.textContent = "Copied"; }
  catch { prompt("Copy this link:", location.href); }
  setTimeout(() => (ui.copyLink.textContent = "Copy link"), 1500);
};
ui.frame.onclick = () => frameView();

// QR code of the page link, to open it on the Quest. Two variants:
// with the reference points (compact #p= code) or just the short site address.
const shortAddress = () => (location.host + location.pathname.replace(/index\.html$/, "")).replace(/\/$/, "");
const qrLink = () => {
  const base = location.origin + location.pathname + location.search;
  return ui.qrWithRef.checked && prep.corner ? base + "#p=" + encodePrep() : base;
};

async function drawQr() {
  const url = qrLink();
  ui.qrUrl.textContent = url;
  try {
    const { qrcode } = await import("qrcode-generator");
    const qr = qrcode(0, "L"); // low error correction = fewer, bigger squares, easier for the headset camera
    qr.addData(url, "Byte");
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, size = n + quiet * 2;
    const scale = Math.max(4, Math.floor(720 / size));
    const cv = ui.qrCanvas;
    cv.width = cv.height = size * scale;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  } catch (err) {
    console.warn(err);
    ui.qrUrl.textContent = "Could not create the QR code (offline?). Link:\n" + url;
  }
}
function showQr() {
  ui.qrShort.textContent = shortAddress();
  ui.qrWithRef.checked = !!prep.corner;
  ui.qrWithRef.disabled = !prep.corner;
  ui.qrModal.classList.remove("hidden");
  drawQr();
}
ui.showQr.onclick = showQr;
ui.qrWithRef.onchange = drawQr;
ui.qrClose.onclick = () => ui.qrModal.classList.add("hidden");
ui.qrModal.addEventListener("click", (e) => { if (e.target === ui.qrModal) ui.qrModal.classList.add("hidden"); });
ui.qrCopy.onclick = async () => {
  try { await navigator.clipboard.writeText(qrLink()); ui.qrCopy.textContent = "Copied"; }
  catch { prompt("Copy this link:", qrLink()); }
  setTimeout(() => (ui.qrCopy.textContent = "Copy link"), 1500);
};

function frameView() {
  if (!splat || !splat.isInitialized) return;
  scene.updateMatrixWorld(true);
  let box;
  try { box = splat.getBoundingBox(true).clone().applyMatrix4(splat.matrixWorld); } catch { return; }
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const r = Math.max(s.x, s.y, s.z, 1);
  controls.target.copy(c);
  camera.position.set(c.x + r * 0.55, c.y + r * 0.75, c.z + r * 0.85);
  controls.update();
}

/* ---------------------------------------------------------------
   WebXR support check
---------------------------------------------------------------- */
async function checkXR() {
  if (!window.isSecureContext) {
    ui.xrmsg.textContent = "WebXR needs a secure page (https:// or localhost). See the README for hosting options.";
    return;
  }
  if (!navigator.xr) {
    ui.xrmsg.textContent = "This browser has no WebXR. Open this page in the Meta Quest Browser.";
    return;
  }
  xrSupport.ar = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  xrSupport.vr = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
  if (xrSupport.ar) ui.xrmsg.textContent = "Headset ready, passthrough available.";
  else if (xrSupport.vr) ui.xrmsg.textContent = "VR only: passthrough is not available here, so Ghost and Blend views show black instead of the room.";
  else ui.xrmsg.textContent = "No headset detected. On a computer you can still load and prepare the splat.";
  updateEnterButton();
}
function updateEnterButton() {
  ui.enter.disabled = !(splat && splat.isInitialized && (xrSupport.ar || xrSupport.vr));
}

/* ---------------------------------------------------------------
   Controllers
---------------------------------------------------------------- */
const modelFactory = new XRControllerModelFactory();
const tipMat = new THREE.MeshBasicMaterial({ color: 0xc6ff3d, depthTest: false, transparent: true });
const ctrlList = [];
const ctrl = { left: null, right: null };
for (let i = 0; i < 2; i++) {
  const ray = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(modelFactory.createControllerModel(grip));
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.007, 16, 12), tipMat);
  tip.renderOrder = 990;
  tip.position.set(0, 0, -0.015);
  tip.visible = false;
  ray.add(tip);
  scene.add(ray, grip);
  const c = { ray, grip, tip, gamepad: null, hand: "", prev: [], hist: [] };
  ray.addEventListener("connected", (e) => {
    c.gamepad = e.data.gamepad || null;
    c.hand = e.data.handedness;
    if (c.hand === "left" || c.hand === "right") ctrl[c.hand] = c;
    c.prev = []; c.hist = [];
  });
  ray.addEventListener("disconnected", () => {
    if (ctrl[c.hand] === c) ctrl[c.hand] = null;
    c.gamepad = null; c.tip.visible = false;
  });
  ctrlList.push(c);
}
const justPressed = (c, i) => !!(c && c.gamepad && c.gamepad.buttons[i]?.pressed && !c.prev[i]);
const held = (c, i) => !!(c && c.gamepad && c.gamepad.buttons[i]?.pressed);
const deadzone = (v) => (Math.abs(v || 0) < 0.15 ? 0 : v);
function haptic(c, strength = 0.6, ms = 60) {
  try { c?.gamepad?.hapticActuators?.[0]?.pulse?.(strength, ms); } catch {}
}

/* ---------------------------------------------------------------
   XR session, calibration, saving
---------------------------------------------------------------- */
const xr = { session: null, mode: "", refType: "local-floor" };
const calib = { yaw: 0, scale: 1 };
let calibStep = 0;            // 0 = off, 1 = waiting for corner, 2 = waiting for wall point
let calibP1 = null;
let followAnchor = null;      // XRAnchor the room follows
let pendingSave = false;
let dirty = false;            // calibration changed but not saved
let calibState = "none";      // none | fresh | restored | anchored
let viewMode = "blend";
let helpVisible = false;
let splatOpacity = 1, targetOpacity = 1;
let fps = 0, fpsAcc = 0, fpsFrames = 0;
let desktopCam = null;

const calibMarkers = [0xc6ff3d, 0x4fd8ff].map((color) => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }));
  m.renderOrder = 980; m.visible = false; scene.add(m); return m;
});

ui.enter.onclick = enterXR;
ui.clearCalib.onclick = () => {
  localStorage.removeItem(LS_CALIB);
  ui.clearCalib.textContent = "Saved calibration cleared";
  setTimeout(() => (ui.clearCalib.textContent = "Forget saved headset calibration"), 1800);
};

async function enterXR() {
  if (!splat) return;
  const mode = xrSupport.ar ? "immersive-ar" : "immersive-vr";
  let session;
  try {
    session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["bounded-floor", "anchors", "hand-tracking"],
    });
  } catch (err) {
    ui.xrmsg.textContent = "Could not start the headset session: " + (err?.message || err);
    return;
  }
  xr.session = session; xr.mode = mode;
  xr.refType = "local-floor";
  try { await session.requestReferenceSpace("bounded-floor"); xr.refType = "bounded-floor"; } catch {}

  desktopCam = { pos: camera.position.clone(), target: controls.target.clone() };
  controls.enabled = false;
  setPickMode(null);
  desktopOnly.visible = false;
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  worldRoot.position.set(0, 0, 0); worldRoot.rotation.set(0, 0, 0); worldRoot.scale.setScalar(1);
  calib.yaw = 0; calib.scale = 1; calibStep = 0; dirty = false; followAnchor = null;
  calibMarkers.forEach((m) => (m.visible = false));
  spark.lodSplatScale = parseFloat(ui.detail.value);

  renderer.xr.setReferenceSpaceType(xr.refType);
  renderer.xr.setFramebufferScaleFactor(parseFloat(ui.quality.value));
  await renderer.xr.setSession(session);
  session.addEventListener("end", onSessionEnd);

  const restored = await restoreCalibration(session);
  setViewMode(restored ? "blend" : "ghost", false);
  helpVisible = !restored;
  hud.flash(restored ? "Calibration restored. Press A for views." : "Press B to calibrate", 4);
}

function onSessionEnd() {
  xr.session = null;
  followAnchor = null; calibStep = 0;
  worldRoot.position.set(0, 0, 0); worldRoot.rotation.set(0, 0, 0); worldRoot.scale.setScalar(1);
  voidSphere.visible = false;
  cornerGuide.visible = true;
  desktopOnly.visible = true;
  scene.background = DESKTOP_BG;
  splatOpacity = targetOpacity = 1;
  if (splat) { splat.opacity = 1; splat.visible = true; }
  hud.hide();
  calibMarkers.forEach((m) => (m.visible = false));
  ctrlList.forEach((c) => (c.tip.visible = false));
  controls.enabled = true;
  if (desktopCam) { camera.position.copy(desktopCam.pos); controls.target.copy(desktopCam.target); }
  camera.quaternion.identity(); camera.scale.set(1, 1, 1);
  onResize();
  controls.update();
}

function loadCalib() { try { return JSON.parse(localStorage.getItem(LS_CALIB)); } catch { return null; } }

async function restoreCalibration(session) {
  const saved = loadCalib();
  if (!saved) { calibState = "none"; return false; }
  calib.scale = saved.scale > 0 ? saved.scale : 1;
  worldRoot.scale.setScalar(calib.scale);
  if (saved.anchor && typeof session.restorePersistentAnchor === "function") {
    try {
      followAnchor = await session.restorePersistentAnchor(saved.anchor);
      calibState = "anchored";
      return true;
    } catch (err) { console.warn("anchor restore failed", err); followAnchor = null; }
  }
  if (saved.refType === xr.refType && saved.pos) {
    worldRoot.position.fromArray(saved.pos);
    calib.yaw = saved.yaw || 0;
    worldRoot.rotation.set(0, calib.yaw, 0);
    calibState = "restored";
    hud.flash("Restored without anchor: check in Ghost view", 4);
    return true;
  }
  calibState = "none";
  return false;
}

function startCalibration() {
  calibStep = 1; calibP1 = null; followAnchor = null;
  calibMarkers.forEach((m) => (m.visible = false));
  setViewMode("ghost", false);
}

function capturePoint(c) {
  if (!c.hist.length) return;
  const p = new THREE.Vector3();
  c.hist.forEach((h) => p.add(h));
  p.divideScalar(c.hist.length);
  haptic(c, 0.8, 80);

  if (calibStep === 1) {
    calibP1 = p;
    calibMarkers[0].position.copy(p); calibMarkers[0].visible = true;
    calibStep = 2;
    hud.flash("Corner captured");
  } else if (calibStep === 2) {
    const dx = p.x - calibP1.x, dz = p.z - calibP1.z;
    if (Math.hypot(dx, dz) < 0.5) { hud.flash("Too close: go further along the wall"); haptic(c, 1, 200); return; }
    calibMarkers[1].position.copy(p); calibMarkers[1].visible = true;
    calib.yaw = Math.atan2(-dz, dx);                 // maps +X (the wall in the splat) onto the real wall
    worldRoot.position.set(calibP1.x, 0, calibP1.z); // floor height comes from the headset (y = 0)
    worldRoot.rotation.set(0, calib.yaw, 0);
    worldRoot.scale.setScalar(calib.scale);
    calibStep = 0; dirty = true; calibState = "fresh";
    hud.flash("Calibrated. Check, fine-tune, then X to save", 4);
  }
}

async function doSave(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  const p = worldRoot.position, q = worldRoot.quaternion;
  const data = { refType: xr.refType, pos: p.toArray(), yaw: calib.yaw, scale: calib.scale, anchor: null, t: Date.now() };
  const old = loadCalib();
  let msg = "Saved (this session only)";
  if (typeof frame.createAnchor === "function" && refSpace) {
    try {
      // createAnchor must be called synchronously inside the frame callback
      const anchorPromise = frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }), refSpace);
      const anchor = await anchorPromise;
      followAnchor = anchor;
      if (typeof anchor.requestPersistentHandle === "function") {
        data.anchor = await anchor.requestPersistentHandle();
        msg = "Saved with spatial anchor";
        if (old?.anchor && old.anchor !== data.anchor && typeof xr.session?.deletePersistentAnchor === "function") {
          xr.session.deletePersistentAnchor(old.anchor).catch(() => {});
        }
      } else msg = "Saved (anchor not persistent here)";
    } catch (err) { console.warn("anchor failed", err); msg = "Saved (anchor failed)"; }
  } else if (xr.refType === "bounded-floor") msg = "Saved (room boundary)";
  try { localStorage.setItem(LS_CALIB, JSON.stringify(data)); } catch {}
  dirty = false; calibState = data.anchor ? "anchored" : "restored";
  hud.flash(msg, 3);
}

function setViewMode(mode, announce = true) {
  viewMode = mode;
  targetOpacity = mode === "reality" ? 0 : mode === "ghost" ? GHOST_OPACITY : 1;
  voidSphere.visible = mode === "void";
  if (announce) {
    const names = { blend: "Blend: splat, room shows through the gaps", void: "Void: splat only", ghost: "Ghost: calibrate and fine-tune", reality: "Reality: passthrough only" };
    hud.flash(names[mode], 2.2);
  }
}
const MODES = ["blend", "void", "ghost", "reality"];

function fineTune(dt) {
  if (viewMode !== "ghost" || calibStep) return;
  const L = ctrl.left, R = ctrl.right;
  const slow = held(L, 1) || held(R, 1) ? 0.15 : 1;
  let changed = false;

  if (L?.gamepad) {
    const x = deadzone(L.gamepad.axes[2]), y = deadzone(L.gamepad.axes[3]);
    if (x || y) {
      const f = camera.getWorldDirection(_v1); f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const rx = -f.z, rz = f.x;               // right vector
      const sp = 0.25 * slow * dt;
      worldRoot.position.x += (rx * x - f.x * y) * sp;
      worldRoot.position.z += (rz * x - f.z * y) * sp;
      changed = true;
    }
  }
  if (R?.gamepad) {
    const x = deadzone(R.gamepad.axes[2]), y = deadzone(R.gamepad.axes[3]);
    const scaling = held(R, 0);
    if (x && !scaling) { calib.yaw -= x * THREE.MathUtils.degToRad(15) * slow * dt; changed = true; }
    if (y) {
      if (scaling) calib.scale *= Math.exp(-y * 0.05 * slow * dt);
      else worldRoot.position.y -= y * 0.15 * slow * dt;
      changed = true;
    }
  }
  if (changed) {
    worldRoot.rotation.set(0, calib.yaw, 0);
    worldRoot.scale.setScalar(calib.scale);
    followAnchor = null;
    dirty = true;
  }
}

function handleButtons() {
  const L = ctrl.left, R = ctrl.right;
  if (justPressed(R, 4)) { calibStep = 0; setViewMode(MODES[(MODES.indexOf(viewMode) + 1) % MODES.length]); }
  if (justPressed(R, 5)) {
    if (calibStep) { calibStep = 0; calibMarkers.forEach((m) => (m.visible = false)); hud.flash("Calibration cancelled"); }
    else startCalibration();
  }
  if (justPressed(L, 4)) pendingSave = true;
  if (justPressed(L, 5)) helpVisible = !helpVisible;
  if (calibStep) for (const c of ctrlList) if (justPressed(c, 0)) capturePoint(c);
}

function updateHudContent() {
  const statusLine = () => {
    const st = dirty ? "Unsaved changes: press X to save" :
      calibState === "anchored" ? "Saved, locked to spatial anchor" :
      calibState === "restored" ? "Saved calibration loaded" :
      calibState === "fresh" ? "Calibrated" : "Not calibrated: press B";
    return `${st}   |   ${fps} fps`;
  };
  if (calibStep === 1) {
    hud.set(true, "Calibration 1 of 2", [
      "Hold the glowing dot of either controller exactly against the reference CORNER (the one picked on the page).",
      "Any height works, only the floor position counts.",
      "Pull the trigger to capture. B cancels.",
    ]);
  } else if (calibStep === 2) {
    hud.set(true, "Calibration 2 of 2", [
      "Now touch the SAME WALL you picked, 1.5 m or more away from the corner.",
      "Pull the trigger to capture.",
    ]);
  } else if (viewMode === "ghost") {
    hud.set(true, "Ghost view: check the fit", [
      "Lime post = virtual corner. Touch real walls and compare.",
      "Left stick: move. Right stick: rotate / height. R trigger + R stick: scale. Hold grip: precise.",
      "X save   B recalibrate   A next view   Y hide",
    ], statusLine());
  } else if (helpVisible) {
    hud.set(true, "Room Splat XR", [
      "A: next view (Blend, Void, Ghost, Reality)",
      "B: calibrate   X: save   Y: hide this panel",
    ], statusLine());
  } else hud.set(false);
}

/* ---------------------------------------------------------------
   Main loop
---------------------------------------------------------------- */
const clock = new THREE.Clock();
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (renderer.xr.isPresenting) xrUpdate(dt, frame);
  else controls.update();
  renderer.render(scene, camera);
});

function xrUpdate(dt, frame) {
  const now = performance.now();
  const refSpace = renderer.xr.getReferenceSpace();

  // Follow the spatial anchor (also corrects tracking drift)
  if (followAnchor && frame && refSpace) {
    const pose = frame.getPose(followAnchor.anchorSpace, refSpace);
    if (pose) {
      const t = pose.transform;
      worldRoot.position.set(t.position.x, t.position.y, t.position.z);
      worldRoot.quaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      calib.yaw = new THREE.Euler().setFromQuaternion(worldRoot.quaternion, "YXZ").y;
      worldRoot.scale.setScalar(calib.scale);
    }
  }

  // Controller tips: record recent positions for a steady capture
  for (const c of ctrlList) {
    if (c.gamepad) {
      c.tip.visible = calibStep > 0 || viewMode === "ghost";
      c.hist.push(c.tip.getWorldPosition(new THREE.Vector3()));
      if (c.hist.length > 10) c.hist.shift();
    } else c.tip.visible = false;
  }

  handleButtons();
  fineTune(dt);
  if (pendingSave && frame) { pendingSave = false; doSave(frame); }

  // Smooth opacity transitions between views
  splatOpacity += (targetOpacity - splatOpacity) * (1 - Math.exp(-dt * 5));
  if (Math.abs(targetOpacity - splatOpacity) < 0.003) splatOpacity = targetOpacity;
  if (splat) { splat.opacity = splatOpacity; splat.visible = splatOpacity > 0.005; }

  cornerGuide.visible = viewMode === "ghost" || calibStep > 0;
  if (!calibStep && viewMode !== "ghost") calibMarkers.forEach((m) => (m.visible = false));
  voidSphere.position.copy(camera.getWorldPosition(_v3));

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

  updateHudContent();
  hud.update(dt, now);

  for (const c of ctrlList) if (c.gamepad) c.prev = c.gamepad.buttons.map((b) => b.pressed);
}

/* ---------------------------------------------------------------
   Resize and start
---------------------------------------------------------------- */
function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

loadPrep();
ui.orient.value = prep.orient;
updatePickButtons();
checkXR();
autoLoad();
