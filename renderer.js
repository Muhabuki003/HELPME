'use strict';

/* StudyBuddy renderer.
 *
 * Runs in two environments:
 *   1. The Electron desktop build — privileged APIs are exposed on
 *      window.studybuddy by preload.js (true OS-level always-on-top widget).
 *   2. A plain browser tab (e.g. hosted on Cloudflare Pages) — falls back to
 *      web-native equivalents: getDisplayMedia for capture, localStorage for
 *      persistence, and Document Picture-in-Picture for an always-on-top window.
 */

const bridge = window.studybuddy || null;
const isElectron = !!bridge;

// Give the page a solid backdrop when running as a hosted web app.
if (!isElectron) document.documentElement.classList.add('web');

// ----------------------------- DOM handles ---------------------------------
const $ = (id) => document.getElementById(id);
const orb = $('orb');
const panel = $('panel');
const recDot = $('recDot');
const recordBtn = $('recordBtn');
const popoutBtn = $('popoutBtn');
const settingsBtn = $('settingsBtn');
const collapseBtn = $('collapseBtn');
const settingsBox = $('settings');
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const statusLine = $('statusLine');
const apiKeyEl = $('apiKey');
const modelEl = $('model');
const intervalEl = $('interval');
const memCountEl = $('memCount');
const clearMemBtn = $('clearMem');
const saveSettingsBtn = $('saveSettings');

// ------------------------- Storage abstraction -----------------------------
// In the browser we persist to localStorage; in Electron to the JSON store.
const LS_SETTINGS = 'studybuddy:settings';
const LS_HISTORY = 'studybuddy:history';

const store = isElectron
  ? {
      getSettings: () => bridge.getSettings(),
      setSettings: (s) => bridge.setSettings(s),
      getHistory: () => bridge.getHistory(),
      addHistory: (e) => bridge.addHistory(e),
      clearHistory: () => bridge.clearHistory(),
    }
  : {
      getSettings: async () => readLS(LS_SETTINGS, {}),
      setSettings: async (s) => {
        const merged = { ...readLS(LS_SETTINGS, {}), ...s };
        writeLS(LS_SETTINGS, merged);
        return merged;
      },
      getHistory: async () => readLS(LS_HISTORY, []),
      addHistory: async (entry) => {
        const list = readLS(LS_HISTORY, []);
        const item = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...entry };
        list.push(item);
        writeLS(LS_HISTORY, list.slice(-400));
        return item;
      },
      clearHistory: async () => {
        writeLS(LS_HISTORY, []);
        return true;
      },
    };

function readLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('localStorage write failed:', err);
  }
}

// ------------------------------- State -------------------------------------
let settings = { apiKey: '', model: 'deepseek-chat', captureIntervalSec: 6 };
let history = [];
let conversation = [];
let recording = false;
let captureTimer = null;
let lastCaptureText = '';
let ocrWorker = null;
let busy = false;

// Browser-only capture stream (persistent so it prompts once per session).
let displayStream = null;
let captureVideo = null;

// Document Picture-in-Picture window (browser always-on-top).
let pipWindow = null;

// --------------------------- Initialisation --------------------------------
(async function init() {
  settings = { ...settings, ...((await store.getSettings()) || {}) };
  history = (await store.getHistory()) || [];
  apiKeyEl.value = settings.apiKey || '';
  modelEl.value = settings.model || 'deepseek-chat';
  intervalEl.value = settings.captureIntervalSec || 6;
  refreshMemCount();

  // Show the pop-out button only when the browser supports Document PiP and
  // we're not already inside the privileged Electron window.
  if (!isElectron && 'documentPictureInPicture' in window) {
    popoutBtn.hidden = false;
  }
  setStatus(
    history.length
      ? `${history.length} snippet${history.length === 1 ? '' : 's'} in memory`
      : 'Ready to help with homework'
  );
})();

function refreshMemCount() {
  memCountEl.textContent = `${history.length} snippet${history.length === 1 ? '' : 's'} remembered`;
}

function setStatus(text) {
  statusLine.textContent = text;
}

// ---------------------- Expand / collapse the widget ------------------------
async function expand() {
  if (isElectron) await bridge.setExpanded(true);
  orb.hidden = true;
  panel.hidden = false;
  inputEl.focus();
}
async function collapse() {
  if (isElectron) await bridge.setExpanded(false);
  panel.hidden = true;
  orb.hidden = false;
  settingsBox.hidden = true;
}

orb.addEventListener('click', expand);
collapseBtn.addEventListener('click', collapse);
settingsBtn.addEventListener('click', () => {
  settingsBox.hidden = !settingsBox.hidden;
});

saveSettingsBtn.addEventListener('click', async () => {
  settings = await store.setSettings({
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
    captureIntervalSec: Math.min(60, Math.max(2, Number(intervalEl.value) || 6)),
  });
  settingsBox.hidden = true;
  setStatus('Settings saved');
});

clearMemBtn.addEventListener('click', async () => {
  await store.clearHistory();
  history = [];
  lastCaptureText = '';
  refreshMemCount();
  setStatus('Memory cleared');
});

// ----------------- Document Picture-in-Picture (browser) -------------------
// Pops the chat panel into a small OS-level floating window that stays on top
// of other windows — the web-native way to get an always-on-top widget.
popoutBtn.addEventListener('click', togglePopout);

async function togglePopout() {
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 420,
      height: 640,
    });

    // Carry our styles into the PiP document.
    for (const sheet of document.styleSheets) {
      try {
        const rules = [...sheet.cssRules].map((r) => r.cssText).join('\n');
        const style = pipWindow.document.createElement('style');
        style.textContent = rules;
        pipWindow.document.head.appendChild(style);
      } catch {
        // Cross-origin sheet — fall back to a <link>.
        if (sheet.href) {
          const link = pipWindow.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipWindow.document.head.appendChild(link);
        }
      }
    }

    pipWindow.document.body.classList.add('pip');
    panel.hidden = false;
    pipWindow.document.body.appendChild(panel); // move the live node; listeners persist
    orb.hidden = true;
    popoutBtn.textContent = '⤡';

    pipWindow.addEventListener('pagehide', () => {
      document.body.appendChild(panel);
      pipWindow = null;
      popoutBtn.textContent = '⧉';
      panel.hidden = true;
      orb.hidden = false;
    });
  } catch (err) {
    console.error('Pop-out failed:', err);
    setStatus('Pop-out not available in this browser');
  }
}

// ------------------------- Screen recording / OCR --------------------------
recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));

async function startRecording() {
  // In the browser, acquire the screen share once before we begin the loop.
  if (!isElectron) {
    try {
      await ensureDisplayStream();
    } catch (err) {
      console.error('getDisplayMedia failed:', err);
      setStatus('Screen share was cancelled');
      return;
    }
  }

  recording = true;
  recordBtn.classList.add('recording');
  recordBtn.textContent = '⏹ Stop';
  recDot.hidden = false;
  setStatus('Recording your screen…');
  captureOnce();
  captureTimer = setInterval(captureOnce, (settings.captureIntervalSec || 6) * 1000);
}

function stopRecording() {
  recording = false;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '⏺ Record';
  recDot.hidden = true;
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
  releaseDisplayStream();
  setStatus(`Remembered ${history.length} snippet${history.length === 1 ? '' : 's'}`);
}

// Browser: open one persistent screen-capture stream for the whole session.
async function ensureDisplayStream() {
  if (displayStream) return;
  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 1 },
    audio: false,
  });
  captureVideo = document.createElement('video');
  captureVideo.muted = true;
  captureVideo.srcObject = displayStream;
  await captureVideo.play();
  // If the user stops sharing via the browser's own control, stop recording.
  displayStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recording) stopRecording();
  });
}

function releaseDisplayStream() {
  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
  }
  displayStream = null;
  captureVideo = null;
}

// Grab one screenshot as a PNG data URL, regardless of environment.
async function grabFrame() {
  if (isElectron) return bridge.captureScreen();
  if (!captureVideo || !captureVideo.videoWidth) throw new Error('No video frame yet');
  const canvas = document.createElement('canvas');
  canvas.width = captureVideo.videoWidth;
  canvas.height = captureVideo.videoHeight;
  canvas.getContext('2d').drawImage(captureVideo, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

// Lazily create the OCR worker (best effort).
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (typeof Tesseract === 'undefined') return null;
  try {
    ocrWorker = await Tesseract.createWorker('eng');
    return ocrWorker;
  } catch (err) {
    console.error('OCR unavailable:', err);
    return null;
  }
}

async function captureOnce() {
  try {
    const dataUrl = await grabFrame();
    const worker = await getOcrWorker();
    if (!worker) {
      setStatus('OCR engine could not load (check your connection)');
      return;
    }
    const {
      data: { text },
    } = await worker.recognize(dataUrl);
    const clean = normalize(text);
    if (clean.length < 25) return; // ignore near-empty screens
    if (similar(clean, lastCaptureText)) return; // skip duplicate frames
    lastCaptureText = clean;
    const entry = await store.addHistory({ time: Date.now(), text: clean.slice(0, 4000) });
    history.push(entry);
    refreshMemCount();
    if (recording) setStatus(`Recording… ${history.length} snippets captured`);
  } catch (err) {
    console.error('capture failed:', err);
    setStatus('Capture failed — try Record again and allow screen sharing');
  }
}

function normalize(t) {
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cheap near-duplicate check based on shared word ratio.
function similar(a, b) {
  if (!b) return false;
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size) > 0.85;
}

// ---------------- Retrieve study context relevant to a query ---------------
function buildContext(query) {
  if (!history.length) return '';
  const terms = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  const scored = history.map((h, idx) => {
    const words = h.text.toLowerCase();
    let score = 0;
    for (const t of terms) if (words.includes(t)) score++;
    score += idx / history.length; // light recency bonus
    return { h, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked = new Map();
  for (const s of scored.slice(0, 8)) picked.set(s.h.id, s.h);
  for (const h of history.slice(-4)) picked.set(h.id, h);

  let budget = 7000;
  const parts = [];
  for (const h of picked.values()) {
    const when = new Date(h.time).toLocaleString();
    const block = `[Seen ${when}]\n${h.text}`;
    if (block.length > budget) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.join('\n\n---\n\n');
}

// ------------------------------- Chat flow ---------------------------------
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener('click', send);

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!settings.apiKey) {
    settingsBox.hidden = false;
    addMessage('assistant', 'Add your DeepSeek API key in ⚙ Settings first, then ask away.');
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  addMessage('user', text);
  conversation.push({ role: 'user', content: text });

  busy = true;
  sendBtn.disabled = true;
  const bubble = addMessage('assistant', '');
  bubble.classList.add('typing');
  bubble.textContent = 'Thinking…';

  try {
    await streamReply(text, bubble);
  } catch (err) {
    console.error(err);
    bubble.classList.remove('typing');
    bubble.textContent = '⚠ ' + describeError(err);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }
}

function describeError(err) {
  const msg = err && err.message ? err.message : 'Request failed.';
  // A bare "Failed to fetch" in the browser usually means CORS/network.
  if (/failed to fetch/i.test(msg) && !isElectron) {
    return (
      'Could not reach the DeepSeek API from the browser. This is usually a CORS/network ' +
      'block. Check your connection, or route requests through a small proxy (see README).'
    );
  }
  return msg;
}

const SYSTEM_PROMPT =
  'You are StudyBuddy, a patient, encouraging tutor that helps the student learn and complete ' +
  'homework. Explain concepts clearly, break topics into steps, and work through problems ' +
  'incrementally — guiding understanding rather than just dumping answers. When the student has ' +
  'recorded their screen, study notes are provided below under "CAPTURED STUDY MATERIAL"; treat ' +
  'that as what they have been reading and ground your explanations in it. If the material does ' +
  'not cover the question, say so and answer from general knowledge. Use simple language and ' +
  'examples.';

async function streamReply(query, bubble) {
  const context = buildContext(query);
  const systemContent = context
    ? `${SYSTEM_PROMPT}\n\n=== CAPTURED STUDY MATERIAL ===\n${context}\n=== END MATERIAL ===`
    : SYSTEM_PROMPT;

  const recentTurns = conversation.slice(-12);
  const messages = [{ role: 'system', content: systemContent }, ...recentTurns];

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-chat',
      messages,
      stream: true,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}. ${detail.slice(0, 160)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  bubble.classList.remove('typing');
  bubble.textContent = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          bubble.innerHTML = renderMarkdown(full);
          scrollToBottom();
        }
      } catch {
        /* ignore keep-alive / partial chunks */
      }
    }
  }

  if (!full) bubble.textContent = '(No response received.)';
  conversation.push({ role: 'assistant', content: full });
}

// ------------------------------ Rendering ----------------------------------
function addMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (text) bubble.innerHTML = renderMarkdown(text);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Minimal, safe markdown: escape first, then add code blocks / inline / bold.
function renderMarkdown(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
