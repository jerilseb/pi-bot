---
name: html-visualize
description: Create visualizations as self-contained HTML files and share a public preview link. Use when the user asks to visualize data, create a presentation, render charts, build interactive demos, or display anything visually in a browser.
---

# HTML Visualize

Create a single self-contained HTML file, serve it, and share a public preview link. No need to ask first and no need to give the user a localhost link.

## When to Use

- User asks to "visualize" anything: data, charts, diagrams, 3D scenes, layouts, etc.
- User wants to see something rendered in a browser
- User asks for a demo, prototype, or interactive page

## Workflow

### 1. Create the HTML File

Write a single self-contained HTML file to `/tmp/html/`. Use a descriptive filename based on what is being visualized.

```text
/tmp/html/visualization.html
```

**Rules for the HTML file:**
- Must be fully self-contained — all CSS, JS, data, and assets inline
- No external file references, except CDN libraries like d3, three.js, chart.js, etc.
- Must work when opened directly in a browser
- Include `<meta charset="UTF-8">` and a `<title>`
- Use responsive layout where practical
- Include all data inline; no fetch calls to local files

**Recommended CDN libraries:**

| Purpose | Library | CDN |
|---------|---------|-----|
| Charts | Chart.js | `https://cdn.jsdelivr.net/npm/chart.js` |
| D3 charts | D3.js | `https://cdn.jsdelivr.net/npm/d3@7` |
| 3D | Three.js | `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js` |
| Maps | Leaflet | `https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js` + CSS |
| Diagrams | Mermaid | `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` |
| Animation | GSAP | `https://cdn.jsdelivr.net/npm/gsap@3.12/dist/gsap.min.js` |
| UI widgets | Alpine.js | `https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js` |

### 2. Start the Public Preview

Run the serve script from the skill directory:

```bash
./scripts/serve.sh [port]
```

If your current working directory is the project root, use:

```bash
.pi/skills/html-visualize/scripts/serve.sh [port]
```

Default port is `8080`. The script starts the local backing server and automatically creates a public localtunnel URL.

### 3. Share Only the Public URL

After the script runs, give the user the public URL to the specific HTML file:

```text
✅ Visualization ready: https://abc123.loca.lt/visualization.html
```

Do not ask whether they want a public preview. Do not share the localhost URL unless the user explicitly asks for it.

If localtunnel shows a confirmation page, tell the user to click "Click to Continue".

## Updating the Visualization

To update the HTML after the server is already running, rewrite the file in `/tmp/html/`. The user can refresh the public preview link to see changes.

## Cleanup Optional

When done, kill the server and tunnel for the port:

```bash
kill $(lsof -ti :8080) 2>/dev/null
pkill -f "localtunnel.*--port 8080" 2>/dev/null
```

Or let them run — the next `serve.sh` call will replace them.

## Tips

- For multiple visualizations, use different filenames, like `chart.html`, `map.html`, or `demo.html`
- Prefer SVG or Canvas rendering for crisp visuals at any zoom
- Add interactivity with Alpine.js or vanilla JS so the user can explore the data
