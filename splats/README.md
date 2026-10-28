# splats

Put your splat files here (.ply, .spz, .sog, .splat, .ksplat). Subfolders work too.

- **Local server** (`npm start`): every file in this folder appears in the "On computer" list on the page. Nothing here is committed to git (see `.gitignore`), so even huge .ply files are fine.
- **Any other folder**: start the server with `npm start -- --splats "/path/to/your/scans"` instead.
- **Published site** (Netlify): only splats you deliberately commit are online. To list them on the page, copy `index.example.json` to `index.json`, edit the names, and remove the matching lines in `.gitignore`. Anyone with the site link can then open the splat.
