# 🎓 StudyBuddy — Floating AI Study Widget

A persistent, always-on-top desktop widget that helps you learn and do homework.
It lives as a small floating circle on top of every window. Click it to open an
AI chatbox powered by the **DeepSeek API**. Hit **Record** and StudyBuddy
watches your screen — lecture notes, textbook chapters, code, documentation —
and remembers it. Then ask questions, and it explains concepts, breaks topics
down, and works through problems step by step using what you actually studied.

Everything runs **locally on your machine**. Your API key and captured study
material are stored on disk in your OS user-data folder and never leave your
computer except for the chat requests you send to DeepSeek.

> **Runs two ways.** The same code runs as a **desktop app** (Electron — a true
> OS-level always-on-top widget) **or as a hosted web page** (e.g. Cloudflare
> Pages). See [Running in the browser](#-running-in-the-browser) below.

## ✨ Features

- **Floating circular launcher** that stays on top of all windows and apps,
  across workspaces and most fullscreen apps.
- **Collapsible chatbox** — click the circle to expand, collapse back to just
  the orb.
- **Screen recording for context** — periodic screenshots are run through
  on-device OCR (Tesseract) and stored as searchable study memory.
- **Context-aware tutoring** — your question is matched against captured
  material and fed to DeepSeek so answers are grounded in what you read.
- **Streaming replies**, code formatting, persistent memory, and a system tray
  icon with show/hide/quit.
- **Drag anywhere** by the orb or the panel header. Lives in the tray.

## 🚀 Getting started

```bash
npm install      # installs Electron + tesseract.js
npm start         # launches the widget
```

1. Click the floating 🎓 circle to open the chatbox.
2. Open **⚙ Settings**, paste your **DeepSeek API key**
   (get one at <https://platform.deepseek.com/api_keys>), pick a model, and save.
3. Press **⏺ Record** while you read your study material. Stop when done.
4. Ask away — e.g. *"Explain the concept on my screen,"* or
   *"Walk me through problem 3 step by step."*

### Models
- `deepseek-chat` — fast, general explanations.
- `deepseek-reasoner` — slower, stronger step-by-step reasoning for hard problems.

## 🌐 Running in the browser

The widget also works as a plain static site (the files are framework-free), so
you can host `index.html`, `styles.css`, and `renderer.js` on Cloudflare Pages,
GitHub Pages, Netlify, etc. In this mode it uses web-native equivalents:

- **Screen capture** → `navigator.mediaDevices.getDisplayMedia()`. Click
  **⏺ Record** and pick a screen/window to share; it captures one frame on each
  interval and stops when you press **⏹ Stop**.
- **Memory & settings** → `localStorage` (stays in your browser).
- **OCR** → Tesseract loaded from a CDN.
- **Always-on-top** → click **⧉ Pop out** to move the chat into a
  [Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
  window that floats above your other windows (Chrome/Edge 116+).

> A browser **tab** can't itself float over other apps — that's an OS
> capability. The **Pop out** button (Document PiP) and the **desktop build**
> are the two ways to get a true always-on-top widget.

### DeepSeek + the browser (CORS)
Calls go directly to `https://api.deepseek.com`. If your browser blocks this
with a CORS/network error, route requests through a tiny same-origin proxy. On
Cloudflare Pages, add `functions/api/deepseek.js`:

```js
export async function onRequestPost({ request, env }) {
  const body = await request.text();
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body,
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
```

Set `DEEPSEEK_API_KEY` as a Pages secret and change the fetch URL in
`renderer.js` to `/api/deepseek`. This also keeps your key off the client.

## 📦 Building a standalone app

```bash
npm run dist        # produces installers in dist/ for your OS
```

Targets: macOS (`dmg`/`zip`), Windows (`nsis`/portable), Linux (`AppImage`/`deb`).

## 🔐 Permissions & privacy

- **macOS**: the first capture will prompt for *Screen Recording* permission
  (System Settings → Privacy & Security → Screen Recording). Grant it to the app.
- Captured text and your API key live in
  `~/Library/Application Support/StudyBuddy/studybuddy.json` (macOS),
  `%APPDATA%/StudyBuddy/studybuddy.json` (Windows), or
  `~/.config/StudyBuddy/studybuddy.json` (Linux).
- Use **Clear memory** in Settings to wipe all captured material at any time.

## 🛠 How it works

| Layer | Responsibility |
|-------|----------------|
| `main.js` | Frameless transparent always-on-top window, screen capture via `desktopCapturer`, tray, and local JSON persistence. |
| `preload.js` | Secure `contextBridge` exposing a minimal IPC surface. |
| `index.html` / `styles.css` | The orb + chat panel UI. |
| `renderer.js` | OCR pipeline, study-memory retrieval, and the DeepSeek streaming chat client. |

## 📝 Notes

- OCR language data (English) downloads once from the Tesseract CDN on first
  capture, then is cached. Other text/processing stays local.
- The widget never quits when closed — it stays in the tray. Quit from the tray
  menu.
