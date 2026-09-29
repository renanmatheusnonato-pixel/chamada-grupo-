// Checagem: o microfone abre numa janela file:// com as permissões do main.js?
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const ALLOWED = ['media', 'audioCapture', 'videoCapture', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(ALLOWED.includes(p)));
  session.defaultSession.setPermissionCheckHandler((_wc, p) => ALLOWED.includes(p));
  session.defaultSession.setDevicePermissionHandler(() => true);

  const win = new BrowserWindow({ show: false });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const r = await win.webContents.executeJavaScript(`(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const t = s.getAudioTracks()[0];
      s.getTracks().forEach(x => x.stop());
      return { ok: true, label: t.label };
    } catch (e) { return { ok: false, name: e.name, message: e.message }; }
  })()`);
  console.log('RESULTADO:', JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
