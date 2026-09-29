const { app, BrowserWindow, session, desktopCapturer, ipcMain, dialog, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { autoUpdater } = require('electron-updater');

let win = null;
const isDev = process.argv.includes('--dev');

// Atualização automática: baixa em segundo plano e instala ao fechar (ou na hora, se o usuário quiser).
function setupAutoUpdate() {
  if (isDev || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async ({ version }) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      title: 'Atualização disponível',
      message: `A versão ${version} foi baixada.`,
      detail: 'Reinicie para usar a versão nova. Se escolher "Depois", ela será instalada quando você fechar o app.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (e) => console.error('Erro ao atualizar:', e.message));
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Chamada em Grupo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // Compartilhamento de tela: em vez do seletor do sistema, mostramos
  // nosso próprio seletor (telas + janelas) dentro do app.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });
      const list = sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
      }));
      ipcMain.removeAllListeners('screen-source-selected');
      ipcMain.once('screen-source-selected', (_e, choice) => {
        const source = choice && sources.find((s) => s.id === choice.id);
        if (!source) return callback({});
        const result = { video: source };
        // Áudio do sistema (loopback) só existe no Windows
        if (choice.withAudio && process.platform === 'win32') result.audio = 'loopback';
        callback(result);
      });
      win?.webContents.send('screen-sources', list);
    } catch (err) {
      console.error('Erro ao listar telas:', err);
      callback({});
    }
  }, { useSystemPicker: false });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });

  // Salvar arquivo (gravação da chamada)
  ipcMain.handle('save-file', async (_e, { data, defaultName, filters }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters,
    });
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, Buffer.from(data));
    return filePath;
  });

  createWindow();
  setupAutoUpdate();

  // Atalhos globais (funcionam mesmo com o app em segundo plano)
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+Alt+${i}`, () => win?.webContents.send('hotkey-sound', i - 1));
  }
  globalShortcut.register('CommandOrControl+Alt+M', () => win?.webContents.send('hotkey-mute'));
  globalShortcut.register('CommandOrControl+Alt+0', () => win?.webContents.send('hotkey-stop-sounds'));

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
