'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Window geometry. The widget has two states:
//   collapsed -> just the floating circle
//   expanded  -> circle + chat panel
// We keep the window anchored to the bottom-right of the work area and only
// grow it up/left so the circle never appears to jump.
// ---------------------------------------------------------------------------
const COLLAPSED = { width: 96, height: 96 };
const EXPANDED = { width: 420, height: 640 };
const MARGIN = 24; // distance from the screen edges

let win = null;
let tray = null;
let isExpanded = false;

// ---------------------------------------------------------------------------
// Tiny persistent JSON store living in the OS user-data directory. Holds the
// DeepSeek API key, user preferences and the captured screen history so the
// widget keeps its memory across restarts. Everything stays on the machine.
// ---------------------------------------------------------------------------
const storePath = () => path.join(app.getPath('userData'), 'studybuddy.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return {
      settings: { apiKey: '', model: 'deepseek-chat', captureIntervalSec: 6 },
      history: [], // [{ id, time, text }]
    };
  }
}

function saveStore(data) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist store:', err);
  }
}

let store = null;

function anchorBottomRight(width, height) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const x = wa.x + wa.width - width - MARGIN;
  const y = wa.y + wa.height - height - MARGIN;
  return { x, y, width, height };
}

function createWindow() {
  const bounds = anchorBottomRight(COLLAPSED.width, COLLAPSED.height);

  win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    // Keep it floating above virtually everything, including most fullscreen apps.
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile('index.html');

  // External links (e.g. "get an API key") open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function setExpanded(expanded) {
  if (!win) return;
  isExpanded = expanded;
  const size = expanded ? EXPANDED : COLLAPSED;
  win.setBounds(anchorBottomRight(size.width, size.height), false);
}

function createTray() {
  // A 1x1 transparent fallback keeps the app working even without an icon file.
  let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (image.isEmpty()) {
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    );
  }
  tray = new Tray(image);
  tray.setToolTip('StudyBuddy — your always-on study helper');
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => (win.isVisible() ? win.hide() : win.show()) },
    { label: 'Reset position', click: () => setExpanded(isExpanded) },
    { type: 'separator' },
    { label: 'Quit StudyBuddy', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => (win.isVisible() ? win.show() : win.show()));
}

// ---------------------------------------------------------------------------
// IPC: bridge between the renderer (UI) and privileged main-process APIs.
// ---------------------------------------------------------------------------

// Expand / collapse the floating window.
ipcMain.handle('widget:setExpanded', (_e, expanded) => {
  setExpanded(Boolean(expanded));
  return isExpanded;
});

// Capture the screen the cursor is currently on and return a PNG data URL.
// The renderer runs OCR on it so the chatbot can "read" what's on screen.
ipcMain.handle('screen:capture', async () => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
    },
  });

  // Match the source to the active display when possible.
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen source available');
  return source.thumbnail.toDataURL();
});

// Settings + history persistence.
ipcMain.handle('store:getSettings', () => store.settings);
ipcMain.handle('store:setSettings', (_e, settings) => {
  store.settings = { ...store.settings, ...settings };
  saveStore(store);
  return store.settings;
});

ipcMain.handle('history:get', () => store.history);
ipcMain.handle('history:add', (_e, entry) => {
  const item = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), ...entry };
  store.history.push(item);
  // Keep memory bounded so the file never grows without limit.
  if (store.history.length > 400) store.history = store.history.slice(-400);
  saveStore(store);
  return item;
});
ipcMain.handle('history:clear', () => {
  store.history = [];
  saveStore(store);
  return true;
});

// ---------------------------------------------------------------------------
// App lifecycle.
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    store = loadStore();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Keep running in the tray; don't quit when the (only) window closes.
  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });
}
