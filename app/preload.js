const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  onScreenSources: (cb) => ipcRenderer.on('screen-sources', (_e, list) => cb(list)),
  selectScreenSource: (choice) => ipcRenderer.send('screen-source-selected', choice),
  saveFile: (data, defaultName, filters) => ipcRenderer.invoke('save-file', { data, defaultName, filters }),
  onHotkeySound: (cb) => ipcRenderer.on('hotkey-sound', (_e, i) => cb(i)),
  onHotkeyMute: (cb) => ipcRenderer.on('hotkey-mute', () => cb()),
  onHotkeyStopSounds: (cb) => ipcRenderer.on('hotkey-stop-sounds', () => cb()),
});
