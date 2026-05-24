---
name: html-visualize
description: Create visualizations as self-contained HTML files served locally, with an optional public tunnel created only after asking the user. Use when the user asks to visualize data, create presentation, render charts, build interactive demos, or display anything visually in a browser.
---

# HTML Visualize

Create a single self-contained HTML file and always serve it locally for preview. Ask the user before creating an optional public tunnel for remote access.

## When to Use

- User asks to "visualize" anything (data, charts, diagrams, 3D scenes, layouts, etc.)
- User wants to see something rendered in a browser
- User asks for a demo, prototype, or interactive page

## Workflow

### 1. Create the HTML File

Write a single self-contained HTML file to `/tmp/html/`. Use a descriptive filename based on what is being visualized.

```
/tmp/html/visualization.html
```

**Rules for the HTML file:**
- Must be fully self-contained — all CSS, JS, data, and assets inline
- No external file references (except CDN libraries like d3, three.js, chart.js, etc.)
- Must work when opened directly in a browser
- Include `<meta charset="UTF-8">` and a `<title>`
- Use responsive layout where practical
- Include all data inline (no fetch calls to local files)

**Recommended CDN libraries (use via `<script src="...">`):**

| Purpose | Library | CDN |
|---------|---------|-----|
| Charts | Chart.js | `https://cdn.jsdelivr.net/npm/chart.js` |
| D3 charts | D3.js | `https://cdn.jsdelivr.net/npm/d3@7` |
| 3D | Three.js | `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js` |
| Maps | Leaflet | `https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js` + CSS |
| Diagrams | Mermaid | `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` |
| Animation | GSAP | `https://cdn.jsdelivr.net/npm/gsap@3.12/dist/gsap.min.js` |
| UI widgets | Alpine.js | `https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js` |

### 2. Start the Local Preview Server

Run the serve script from the skill directory using a relative path:

```bash
./scripts/serve.sh [port]
```

If your current working directory is the project root, use the project-relative path:

```bash
.pi/skills/html-visualize/scripts/serve.sh [port]
```

Default port is `8080`. By default, the script creates **local preview only**. The script:
- Creates `/tmp/html/` if it doesn't exist
- Kills any existing server/tunnel on the port
- Starts a local preview server on the port
- Outputs `LOCAL_URL` every time
- Outputs `TUNNEL_URL=(not requested)` unless public preview was explicitly requested

### 3. Share the Local URL and Ask About Public Preview

After the script runs, always give the user the **local URL** first:

```
✅ Visualization ready!
- Local: http://localhost:8080/visualization.html
```

Then ask the user whether they want a public preview/tunnel. Use `ask_user` with a yes/no question, for example:

```
Would you like me to create a public preview link for this visualization?
```

Do **not** create a public tunnel unless the user says yes.

### 4. Create Public Preview Only If Requested

If the user confirms they want public preview, rerun the serve script with `--public`:

```bash
./scripts/serve.sh [port] --public
```

From the project root, use:

```bash
.pi/skills/html-visualize/scripts/serve.sh [port] --public
```

Then share both URLs:

```
✅ Public preview ready!
- Local:  http://localhost:8080/visualization.html
- Public: https://abc123.loca.lt/visualization.html
```

If localtunnel shows a confirmation page, tell the user to click "Click to Continue".

### 5. Cleanup (Optional)

When done, kill the server and any tunnel for the port:

```bash
kill $(lsof -ti :8080) 2>/dev/null
pkill -f "localtunnel.*--port 8080" 2>/dev/null
```

Or let them run — the next `serve.sh` call will replace them.

## Updating the Visualization

To update the HTML after the server is already running, simply rewrite the file in `/tmp/html/`. The user can refresh the browser to see changes — no server restart needed.

## Tips

- For multiple visualizations, use different filenames (e.g., `chart.html`, `map.html`)
- If localtunnel shows a confirmation page, tell the user to click "Click to Continue"
- Prefer SVG or Canvas rendering for crisp visuals at any zoom
- Add interactivity with Alpine.js or vanilla JS — the user can explore the data
