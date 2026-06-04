'use strict';

/* StudyBuddy renderer — UI, screen-capture/OCR pipeline, and DeepSeek chat. */

const api = window.studybuddy;

// ----------------------------- DOM handles ---------------------------------
const $ = (id) => document.getElementById(id);
const orb = $('orb');
const panel = $('panel');
const recDot = $('recDot');
const recordBtn = $('recordBtn');
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

// ------------------------------- State -------------------------------------
let settings = { apiKey: '', model: 'deepseek-chat', captureIntervalSec: 6 };
let history = []; // captured screen snippets {id, time, text}
let conversation = []; // chat turns {role, content}
let recording = false;
let captureTimer = null;
let lastCaptureText = '';
let ocrWorker = null;
let busy = false;

// --------------------------- Initialisation --------------------------------
(async function init() {
  settings = (await api.getSettings()) || settings;
  history = (await api.getHistory()) || [];
  apiKeyEl.value = settings.apiKey || '';
  modelEl.value = settings.model || 'deepseek-chat';
  intervalEl.value = settings.captureIntervalSec || 6;
  refreshMemCount();
})();

function refreshMemCount() {
  memCountEl.textContent = `${history.length} snippet${history.length === 1 ? '' : 's'} remembered`;
}

// ---------------------- Expand / collapse the widget ------------------------
async function expand() {
  await api.setExpanded(true);
  orb.hidden = true;
  panel.hidden = false;
  inputEl.focus();
}
async function collapse() {
  await api.setExpanded(false);
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
  settings = await api.setSettings({
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value,
    captureIntervalSec: Math.min(60, Math.max(2, Number(intervalEl.value) || 6)),
  });
  settingsBox.hidden = true;
  setStatus('Settings saved');
});

clearMemBtn.addEventListener('click', async () => {
  await api.clearHistory();
  history = [];
  lastCaptureText = '';
  refreshMemCount();
  setStatus('Memory cleared');
});

function setStatus(text) {
  statusLine.textContent = text;
}

// ------------------------- Screen recording / OCR --------------------------
recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));

function startRecording() {
  recording = true;
  recordBtn.classList.add('recording');
  recordBtn.textContent = '⏹ Stop';
  recDot.hidden = false;
  setStatus('Recording your screen…');
  // Capture immediately, then on the configured interval.
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
  setStatus(`Remembered ${history.length} snippet${history.length === 1 ? '' : 's'}`);
}

// Lazily create the OCR worker (best effort — works if tesseract.js is present).
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (typeof Tesseract === 'undefined') return null;
  try {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
    });
    return ocrWorker;
  } catch (err) {
    console.error('OCR unavailable:', err);
    return null;
  }
}

async function captureOnce() {
  try {
    const dataUrl = await api.captureScreen();
    const worker = await getOcrWorker();
    if (!worker) {
      setStatus('OCR unavailable — install dependencies (npm install)');
      return;
    }
    const {
      data: { text },
    } = await worker.recognize(dataUrl);
    const clean = normalize(text);
    if (clean.length < 25) return; // ignore near-empty screens
    if (similar(clean, lastCaptureText)) return; // skip duplicate frames
    lastCaptureText = clean;
    const entry = await api.addHistory({ time: Date.now(), text: clean.slice(0, 4000) });
    history.push(entry);
    refreshMemCount();
    if (recording) setStatus(`Recording… ${history.length} snippets captured`);
  } catch (err) {
    console.error('capture failed:', err);
    setStatus('Capture failed — check screen-recording permission');
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
    // Light recency bonus so recent material wins ties.
    score += idx / history.length;
    return { h, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Top relevant snippets + always include the few most recent ones.
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
    bubble.textContent = '⚠ ' + (err.message || 'Request failed. Check your API key and network.');
  } finally {
    busy = false;
    sendBtn.disabled = false;
    scrollToBottom();
  }
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

  // Keep the last several turns for continuity without unbounded growth.
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
    buffer = lines.pop(); // keep the last partial line
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
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
