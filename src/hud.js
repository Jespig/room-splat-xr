// Headset HUD: a canvas texture on a plane that lazily follows the head.
import * as THREE from "three";

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export class Hud {
  constructor(scene, camera) {
    this.camera = camera;
    this.cv = document.createElement("canvas");
    this.cv.width = 1024; this.cv.height = 600;
    this.ctx = this.cv.getContext("2d");
    this.tex = new THREE.CanvasTexture(this.cv);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6 * 600 / 1024),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false }));
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.title = ""; this.lines = []; this.foot = "";
    this.toast = ""; this.toastUntil = 0;
    this.panel = false; this.snapped = false; this.dirty = true; this.key = "";
  }

  // Panel content. Only redraws when something changed.
  set(panel, title = "", lines = [], foot = "") {
    const key = JSON.stringify([panel, title, lines, foot]);
    if (key === this.key) return;
    this.key = key; this.panel = panel; this.title = title; this.lines = lines; this.foot = foot; this.dirty = true;
  }

  // Short message at the bottom, visible even when the panel is hidden.
  flash(msg, sec = 2.8) { this.toast = msg; this.toastUntil = performance.now() + sec * 1000; this.dirty = true; }

  hide() { this.mesh.visible = false; this.snapped = false; }

  draw(now) {
    const { ctx, cv } = this;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const toastOn = now < this.toastUntil;
    if (this.panel) {
      roundRect(ctx, 8, 8, cv.width - 16, cv.height - 16, 28, "rgba(12,14,18,0.86)");
      ctx.fillStyle = "#c6ff3d"; ctx.font = "700 46px system-ui, sans-serif";
      ctx.fillText(this.title, 44, 84);
      ctx.fillStyle = "#e8eaed"; ctx.font = "32px system-ui, sans-serif";
      let y = 148;
      for (const l of this.lines) y = wrapText(ctx, l, 44, y, cv.width - 88, 42) + 12;
      if (this.foot) {
        ctx.fillStyle = "#4fd8ff"; ctx.font = "600 30px system-ui, sans-serif";
        ctx.fillText(this.foot, 44, cv.height - (toastOn ? 120 : 44));
      }
    }
    if (toastOn) {
      ctx.font = "700 34px system-ui, sans-serif";
      const w = Math.min(cv.width - 40, ctx.measureText(this.toast).width + 60);
      roundRect(ctx, (cv.width - w) / 2, cv.height - 100, w, 72, 36, "#c6ff3d");
      ctx.fillStyle = "#111"; ctx.textAlign = "center";
      ctx.fillText(this.toast, cv.width / 2, cv.height - 52, cv.width - 80);
      ctx.textAlign = "left";
    }
    this.tex.needsUpdate = true;
    this.drawnToast = toastOn;
  }

  update(dt, now) {
    const toastOn = now < this.toastUntil;
    if (toastOn !== this.drawnToast) this.dirty = true;
    if (this.dirty) { this.draw(now); this.dirty = false; }
    this.mesh.visible = this.panel || toastOn;
    if (!this.mesh.visible) { this.snapped = false; return; }
    const head = this.camera.getWorldPosition(_v1);
    const dir = this.camera.getWorldDirection(_v2); dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const target = _v3.copy(head).addScaledVector(dir, 0.85); target.y -= 0.2;
    if (!this.snapped) { this.mesh.position.copy(target); this.snapped = true; }
    else this.mesh.position.lerp(target, 1 - Math.exp(-dt * 3.5));
    this.mesh.lookAt(head);
  }
}

function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}

function wrapText(ctx, text, x, y, maxW, lh) {
  let line = "";
  for (const word of text.split(" ")) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, y); line = word; y += lh; }
    else line = test;
  }
  ctx.fillText(line, x, y);
  return y + lh;
}
