#!/usr/bin/env node
// Convert a big .ply splat into a much smaller .spz (or .sog) with PlayCanvas splat-transform.
//
//   npm run compress -- path/to/room.ply                 writes path/to/room.spz
//   npm run compress -- path/to/room.ply splats/room.sog
//   npm run compress -- path/to/room.ply --sh 1          also drops higher spherical harmonics (smaller, less shine)
//
// The first run downloads splat-transform through npx.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const argv = process.argv.slice(2);
const shIdx = argv.indexOf("--sh");
const sh = shIdx >= 0 ? argv.splice(shIdx, 2)[1] : null;
const [input, outArg] = argv;

if (!input || !fs.existsSync(input)) {
  console.log("Usage: npm run compress -- <input.ply> [output.spz|output.sog] [--sh 0-3]");
  process.exit(input ? 1 : 0);
}

const output = outArg || path.join(path.dirname(input), path.basename(input, path.extname(input)) + ".spz");
const cmdArgs = ["-y", "@playcanvas/splat-transform@3", "-w", input, "-N"];
if (sh !== null) cmdArgs.push("-H", String(sh));
cmdArgs.push(output);

console.log(`Converting ${input}  ->  ${output}`);
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", cmdArgs, { stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => {
  if (code === 0 && fs.existsSync(output)) {
    const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1) + " MB";
    console.log(`Done: ${mb(input)}  ->  ${mb(output)}`);
  }
  process.exit(code ?? 1);
});
