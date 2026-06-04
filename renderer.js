'use strict';

/* StudyBuddy — browser-only renderer.
 * Storage: localStorage. Capture: getDisplayMedia. Float: Document PiP.
 */

// ----------------------------- DOM handles ---------------------------------
const $ = (id) => document.getElementById(id);
const orb        = $('orb');
const panel      = $('panel');
const recDot     = $('recDot');
const recordBtn  = $('recordBtn');
const popoutBtn  = $('popoutBtn');
const settingsBtn  = $('settingsBtn');
const collapseBtn  = $('collapseBtn');
const settingsBox  = $('settings');
const messagesEl   = $('messages');
const inputEl      = $('input');
const sendBtn      = $('sendBtn');
const statusLine   = $('statusLine');
const apiKeyEl     = $('apiKey');
const modelEl      = $('model');
const intervalEl   = $('interval');
const memCountEl   = $('memCount');
const clearMemBtn  = $('clearMem');
const saveSettingsBtn = $('saveSettings');

// ------------------------------ Storage ------------------------------------
const LS = { SETTINGS: 'sb:settings', HISTORY: 'sb:history' };

function lsRead(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function lsWrite(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ------------------------------- State -------------------------------------
let settings = { apiKey: '', model: 'deepseek-chat', captureIntervalSec: 6 };
let history   = [];     // [{ id, time, text }]
let convo     = [];     // [{ role, content }]
let recording = false;
let captureTimer   = null;
let lastText       = '';
let ocrWorker      = null;
let busy           = false;
let displayStream  = null;
let captureVideo   = null;
let pipWindow      = null;

// --------------------------- Init ------------------------------------------
(function init() {
  settings = { ...settings, ...lsRead(LS.SETTINGS, {}) };
  history  = lsRead(LS.HISTORY, []);
  apiKeyEl.value   = settings.apiKey || '';
  modelEl.value    = settings.model  || 'deepseek-chat';
  intervalEl.value = settings.captureIntervalSec || 6;
  refreshMem();
  setStatus(history.length ? `${history.length} snippets in memory` : 'Ready to help');
  if ('documentPictureInPicture' in window) popoutBtn.hidden = false;
})();

function refreshMem() {
  memCountEl.textContent = `${history.length} snippet${history.length === 1 ? '' : 's'} remembered`;
}
function setStatus(t) { statusLine.textContent = t; }

// ----------------------- Expand / collapse ---------------------------------
function expand() {
  orb.hidden   = true;
  panel.hidden = false;
  inputEl.focus();
}
function collapse() {
  panel.hidden = true;
  orb.hidden   = false;
  settingsBox.hidden = true;
}

orb.addEventListener('click', expand);
collapseBtn.addEventListener('click', collapse);
settingsBtn.addEventListener('click', () => { settingsBox.hidden = !settingsBox.hidden; });

saveSettingsBtn.addEventListener('click', () => {
  settings = {
    apiKey: apiKeyEl.value.trim(),
    model:  modelEl.value,
    captureIntervalSec: Math.min(60, Math.max(2, Number(intervalEl.value) || 6)),
  };
  lsWrite(LS.SETTINGS, settings);
  settingsBox.hidden = true;
  setStatus('Settings saved');
});

clearMemBtn.addEventListener('click', () => {
  lsWrite(LS.HISTORY, []);
  history   = [];
  lastText  = '';
  refreshMem();
  setStatus('Memory cleared');
});

// ------------------- Document Picture-in-Picture ---------------------------
popoutBtn.addEventListener('click', togglePip);

async function togglePip() {
  if (pipWindow) { pipWindow.close(); return; }
  try {
    pipWindow = await window.documentPictureInPicture.requestWindow({ width: 420, height: 640 });

    // Clone styles into the PiP document.
    for (const sheet of document.styleSheets) {
      try {
        const css = [...sheet.cssRules].map(r => r.cssText).join('\n');
        const s = pipWindow.document.createElement('style');
        s.textContent = css;
        pipWindow.document.head.appendChild(s);
      } catch {
        if (sheet.href) {
          const l = pipWindow.document.createElement('link');
          l.rel = 'stylesheet'; l.href = sheet.href;
          pipWindow.document.head.appendChild(l);
        }
      }
    }

    pipWindow.document.body.classList.add('pip');
    panel.hidden = false;
    pipWindow.document.body.appendChild(panel);
    orb.hidden = true;
    popoutBtn.textContent = '⤡';

    pipWindow.addEventListener('pagehide', () => {
      document.body.appendChild(panel);
      pipWindow = null;
      popoutBtn.textContent = '⧉';
      panel.hidden = true;
      orb.hidden   = false;
    });
  } catch (err) {
    console.error('PiP failed:', err);
    setStatus('Pop-out blocked — use Chrome/Edge 116+');
  }
}

// ----------------------- Screen recording / OCR ----------------------------
recordBtn.addEventListener('click', () => recording ? stopRec() : startRec());

async function startRec() {
  try {
    await ensureStream();
  } catch {
    setStatus('Screen share cancelled');
    return;
  }
  recording = true;
  recordBtn.classList.add('recording');
  recordBtn.textContent = '⏹ Stop';
  recDot.hidden = false;
  setStatus('Recording your screen…');
  captureOnce();
  captureTimer = setInterval(captureOnce, (settings.captureIntervalSec || 6) * 1000);
}

function stopRec() {
  recording = false;
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '⏺ Record';
  recDot.hidden = true;
  clearInterval(captureTimer);
  captureTimer = null;
  releaseStream();
  setStatus(`Remembered ${history.length} snippet${history.length === 1 ? '' : 's'}`);
}

async function ensureStream() {
  if (displayStream) return;
  displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
  captureVideo  = document.createElement('video');
  captureVideo.muted = true;
  captureVideo.srcObject = displayStream;
  await captureVideo.play();
  displayStream.getVideoTracks()[0].addEventListener('ended', () => { if (recording) stopRec(); });
}

function releaseStream() {
  displayStream?.getTracks().forEach(t => t.stop());
  displayStream = null;
  captureVideo  = null;
}

async function grabFrame() {
  if (!captureVideo?.videoWidth) throw new Error('No video frame');
  const c = document.createElement('canvas');
  c.width  = captureVideo.videoWidth;
  c.height = captureVideo.videoHeight;
  c.getContext('2d').drawImage(captureVideo, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function getWorker() {
  if (ocrWorker) return ocrWorker;
  if (typeof Tesseract === 'undefined') return null;
  try {
    ocrWorker = await Tesseract.createWorker('eng');
    return ocrWorker;
  } catch { return null; }
}

async function captureOnce() {
  try {
    const dataUrl = await grabFrame();
    const worker  = await getWorker();
    if (!worker) { setStatus('OCR loading — try again in a moment'); return; }
    const { data: { text } } = await worker.recognize(dataUrl);
    const clean = norm(text);
    if (clean.length < 25 || similar(clean, lastText)) return;
    lastText = clean;
    const entry = { id: Date.now() + '-' + Math.random().toString(36).slice(2,6), time: Date.now(), text: clean.slice(0, 4000) };
    history.push(entry);
    lsWrite(LS.HISTORY, history.slice(-400));
    refreshMem();
    if (recording) setStatus(`Recording… ${history.length} snippets captured`);
  } catch (err) {
    console.error('capture:', err);
    setStatus('Capture error — try Record again');
  }
}

function norm(t) { return t.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim(); }

function similar(a, b) {
  if (!b) return false;
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!wa.size || !wb.size) return false;
  let s = 0; for (const w of wa) if (wb.has(w)) s++;
  return s / Math.max(wa.size, wb.size) > 0.85;
}

// --------------------- Context retrieval ----------------------------------
function buildContext(query) {
  if (!history.length) return '';
  const terms = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const scored = history.map((h, i) => {
    let score = 0;
    const words = h.text.toLowerCase();
    for (const t of terms) if (words.includes(t)) score++;
    score += i / history.length;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = new Map();
  scored.slice(0, 8).forEach(s => picked.set(s.h.id, s.h));
  history.slice(-4).forEach(h => picked.set(h.id, h));
  let budget = 7000;
  const parts = [];
  for (const h of picked.values()) {
    const block = `[Seen ${new Date(h.time).toLocaleString()}]\n${h.text}`;
    if (block.length > budget) break;
    budget -= block.length;
    parts.push(block);
  }
  return parts.join('\n\n---\n\n');
}

// ----------------------------- Chat ---------------------------------------
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
});
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
sendBtn.addEventListener('click', send);

async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  if (!settings.apiKey) {
    settingsBox.hidden = false;
    addMsg('assistant', 'Open ⚙ Settings and add your DeepSeek API key first.');
    return;
  }
  inputEl.value = '';
  inputEl.style.height = 'auto';
  addMsg('user', text);
  convo.push({ role: 'user', content: text });
  busy = true; sendBtn.disabled = true;
  const bubble = addMsg('assistant', '');
  bubble.classList.add('typing');
  bubble.textContent = 'Thinking…';
  try {
    await stream(text, bubble);
  } catch (err) {
    bubble.classList.remove('typing');
    bubble.textContent = '⚠ ' + err.message;
  } finally {
    busy = false; sendBtn.disabled = false; scrollDown();
  }
}

const SYSTEM =
  'You are StudyBuddy, a patient encouraging tutor. Explain concepts clearly, break topics into ' +
  'steps, and work through problems incrementally — guide understanding rather than dump answers. ' +
  'When the student has recorded their screen, study notes appear under "CAPTURED STUDY MATERIAL" ' +
  'below — ground your explanations in that material. If material doesn\'t cover the question, ' +
  'say so and answer from general knowledge. Use simple language and examples.';

async function stream(query, bubble) {
  const ctx = buildContext(query);
  const system = ctx ? `${SYSTEM}\n\n=== CAPTURED STUDY MATERIAL ===\n${ctx}\n=== END ===` : SYSTEM;
  const messages = [{ role: 'system', content: system }, ...convo.slice(-12)];

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model || 'deepseek-chat', messages, stream: true, temperature: 0.4 }),
  });

  if (!res.ok) {
    const d = await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${d.slice(0, 120)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  bubble.classList.remove('typing');
  bubble.textContent = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (p === '[DONE]') continue;
      try {
        const delta = JSON.parse(p).choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; bubble.innerHTML = md(full); scrollDown(); }
      } catch {}
    }
  }

  if (!full) bubble.textContent = '(No response received.)';
  convo.push({ role: 'assistant', content: full });
}

// -------------------------- Rendering -------------------------------------
function addMsg(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (text) bubble.innerHTML = md(text);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollDown();
  return bubble;
}

function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function md(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_,_l,c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
