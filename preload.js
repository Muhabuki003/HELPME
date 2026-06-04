'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer. No direct Node access.
contextBridge.exposeInMainWorld('studybuddy', {
  setExpanded: (expanded) => ipcRenderer.invoke('widget:setExpanded', expanded),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),

  getSettings: () => ipcRenderer.invoke('store:getSettings'),
  setSettings: (settings) => ipcRenderer.invoke('store:setSettings', settings),

  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (entry) => ipcRenderer.invoke('history:add', entry),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
});
