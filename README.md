# Room Splat XR

Walk through a Gaussian splat of a room on Meta Quest 3 while standing in that same room. The splat is aligned to the real walls, so what you see is virtual, but what you touch is real.

Built with three.js and [Spark](https://sparkjs.dev), runs in the Meta Quest Browser via WebXR. No build step.

There are two ways to run it:

| | **Local** (your computer) | **Online** (Netlify) |
|---|---|---|
| Splat size | Any, even multi-GB .ply files | Best under 100 MB (.spz/.sog) |
| Splat stays private | Yes, never leaves your computer | Only if you don't publish it (anyone with the link can open the site) |
| Needs | Node.js, adb, USB cable (or wireless adb) | Only the Quest |
| Updates | Instantly on reload | About a minute after each push |

---

## 1. Local setup (recommended for big .ply files)

### One-time installs
1. **Node.js 18+**: nodejs.org
2. **adb** (Android platform-tools):
   - macOS: `brew install android-platform-tools`
   - Windows: `winget install Google.PlatformTools`
   - or download "SDK Platform-Tools" from developer.android.com
3. **Developer mode on the Quest**: in the Meta Horizon phone app, go to your headset, Developer mode, switch it on. The first time you plug in the USB cable, put on the headset and allow USB debugging (tick "always allow").

### Every session
```bash
git clone https://github.com/<you>/room-splat-xr.git   # once
cd room-splat-xr
npm start
```
- Put your splats in the `splats/` folder (ignored by git, so size doesn't matter), **or** point the server at any folder on your computer:
  ```bash
  npm start -- --splats "D:\Scans\Rooms"
  npm start -- --splats ~/Documents/scans
  ```
- Plug the Quest in by USB. The terminal prints `Quest connected: open http://localhost:8080`.
- Open **http://localhost:8080** in the Quest browser. Your splats appear in the **On computer** list. Pick one and press Load.

The server keeps the USB link alive automatically (it re-runs `adb reverse` every few seconds), so re-plugging the cable is fine.

**Without a cable (wireless adb):** while plugged in once, run `adb tcpip 5555`, unplug, then `adb connect <quest-ip>:5555`. The server then works over Wi-Fi the same way.

**Preparing on the computer:** open http://localhost:8080 in your desktop browser to set the reference points with mouse and keyboard (see section 3). Then press **Copy link** and open that link on the Quest, or just redo the two clicks on the Quest.

### Big files
- Files over 300 MB are streamed from disk instead of read into memory in one piece.
- Scans with more than about 1 million splats automatically get a level-of-detail version in the headset, so they stay smooth on Quest 3.
- To make a .ply much smaller (often 5 to 10 times), convert it:
  ```bash
  npm run compress -- splats/room.ply              # writes splats/room.spz
  npm run compress -- splats/room.ply --sh 1       # even smaller, slightly less view-dependent shine
  ```
  The first run downloads PlayCanvas splat-transform via npx.

---

## 2. Online setup (Netlify)

The site is deployed by Netlify from this repo. Every push to `main` updates it after about a minute.

1. One-time setup: app.netlify.com, Add new site, Import an existing project, GitHub, pick `room-splat-xr`. Branch `main`, build command empty, publish directory `.` (also set in `netlify.toml`).
2. Open the Netlify link (Site configuration shows it, and lets you rename it) in the Quest browser.
3. Load a splat:
   - **File picker:** copy the splat onto the Quest (USB, it shows up as a drive) and choose it. With "Remember this file" it is stored on the headset and loads automatically next time, without being copied into memory.
   - **URL:** paste a link to a splat (it must be https and allow cross-origin requests).
   - **From your computer while the server runs:** with the Quest connected by adb, paste `http://localhost:8080/splats/room.ply` into the URL field. The online page loads the file straight from your computer.
   - **Published with the site:** see `splats/README.md` (the splat becomes public).

Tip: on the Quest, reload the page after pushing an update. The version number at the bottom of the panel shows which version is running.

---

## 3. Set the reference points (once per splat)

This tells the app which corner of the scan is the origin. Easiest on a computer.

1. Load the splat. You see it above a grid.
2. **Orientation:** the floor must lie flat on the grid. If the room is upside down or on its side, switch between "Y down", "Y up" and "Z up".
3. **Pick corner:** click a room corner exactly where it meets the floor. A lime post appears there, and the room moves so this corner sits at the grid origin.
4. **Pick wall point:** click a point on the floor along one of the two walls of that corner, at least 1.5 m away. The blue arrow now runs along that wall.
5. **Write down which corner and which wall you chose.** You will touch exactly these in the headset. Pick a corner that is free of furniture and easy to reach.
6. Optional scale check: press **Measure**, click two points you can also measure in reality (door width, table length), type the real distance in metres and press **Set scale**. LiDAR scans are usually right already, so only correct it if it is off by more than 1 to 2 cm.

The settings are stored on the device and in the page link. To open the page on the Quest with these settings:
- **QR code:** shows the link as a QR code. If a splat is loaded, it is **sent along**: keep the window open, scan the code with the headset, and the file goes straight from your computer's browser to the Quest (peer to peer, fastest on the same Wi-Fi; only the connection setup uses the public PeerJS server). The Quest keeps it, so next time it loads by itself. Scanning needs a QR scanner app from the Horizon Store (the built-in camera only reads Wi-Fi codes). Make the window big and bright and hold the screen 30 to 50 cm in front of the headset.
- **Short address:** the same window shows the plain site address in large letters to type in the Quest browser (rename the Netlify site to something short, e.g. `roomsplat.netlify.app`). This opens the page without the reference points, so set them again on the Quest, which takes two clicks.
- **Copy link:** send the full link to yourself.

## 4. Calibrate in the headset

Stand in the real room, with good light (Quest tracking needs it).

1. Press **Enter headset** and allow the permissions. You start in **Ghost view**: passthrough with the splat on top at half opacity.
2. Press **B**. The HUD says *Calibration 1 of 2*.
3. Walk to the reference **corner**. Hold a controller so the small **glowing dot** at its front sits exactly on the vertical edge where the two walls meet. Any height works, only the floor position counts. Hold still and pull the **trigger**.
4. *Calibration 2 of 2*: move along the **same wall**, at least 1.5 m (3 m or the full wall is more accurate). Hold the dot against the wall and pull the **trigger**.
5. The splat snaps onto the room. Check it: the lime post should stand in the real corner, the blue arrow should run along the real wall. Touch walls, door frames and furniture and compare.
6. **Fine-tune** if needed (Ghost view only): left stick moves, right stick rotates (left/right) and sets height (up/down), right trigger held + right stick scales, holding a grip button makes everything slow and precise.
7. Press **X** to save:
   - *Saved with spatial anchor*: restores automatically next time and stays locked to the room.
   - *Saved (room boundary)* or *this session only*: calibrate again at the start of each session (about 20 seconds).
8. Press **A** to switch to **Blend** and start.

If it ever drifts, press **B**, repeat, and save again. Before an exhibition, check once in Ghost view after every headset restart.

## Views (button A)

| View | What you see |
|---|---|
| **Blend** | The full splat. Where the scan has gaps or holes, the real room shows through. The main mode. |
| **Void** | Only the splat, black around it. Fully virtual. |
| **Ghost** | Splat at half opacity over passthrough. For calibrating and checking. |
| **Reality** | Passthrough only, the splat fades out. |

## Controls

| Button | Action |
|---|---|
| B | Start calibration (press again to cancel) |
| Trigger | Capture the point at the glowing dot (during calibration) |
| A | Next view |
| X | Save calibration |
| Y | Show or hide the help panel |
| Left stick (Ghost) | Move |
| Right stick (Ghost) | Rotate, height |
| Right trigger + right stick (Ghost) | Scale |
| Grip (hold) | Precise, slow |

---

## Project structure

```
index.html            page markup, import map (three.js 0.180, Spark 2.4 from CDN)
css/style.css         page styles
src/main.js           scene, loading, reference points, XR session, calibration, main loop
src/hud.js            in-headset text panel
src/sources.js        on-device cache, server list, manifest
src/transfer.js       send a splat from computer to headset (WebRTC, PeerJS)
server/serve.mjs      local server: app + splat folder, range requests, adb reverse
tools/compress.mjs    .ply to .spz/.sog converter (splat-transform)
splats/               your splats (ignored by git)
```

### Iterating
- With `npm start` running, edit a file and reload the page on the Quest. App files are never cached by the local server.
- Bump `APP_VERSION` in `src/main.js` when you push, so you can see on the Quest which version is running.
- Commit and push (GitHub Desktop: Commit to main, Push origin): Netlify updates the online version by itself.

## Troubleshooting

- **"WebXR needs a secure page"**: the page is not on https or localhost. Use `http://localhost:8080` via adb, or the Netlify link.
- **Server says "Waiting for the Quest"**: check the cable, developer mode, and the USB debugging prompt inside the headset. `adb devices` should list the Quest.
- **Room is upside down or on its side**: change Orientation, then pick the corner and wall again.
- **Splat is rotated by about 90 degrees after calibration**: you touched the other wall of the corner. Recalibrate with the same wall as on the page.
- **Everything is a few centimetres off**: recalibrate with the wall point further away, fine-tune, save.
- **Calibration not restored**: anchors may have been cleared (for example after a new Space Setup). Calibrate again.
- **Very large .ply crashes the Quest browser**: run `npm run compress` or crop the scan in SuperSplat. Memory on the headset is the limit, not the app.
- **Stutters**: choose Render quality "Fast" or Splat detail "Light" before entering. The fps value is shown in the Ghost panel, aim for 72.
