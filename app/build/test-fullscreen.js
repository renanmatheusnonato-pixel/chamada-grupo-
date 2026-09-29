// Checagem: requestFullscreen num elemento funciona na janela do app?
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // userGesture = true simula o clique do usuário exigido pela Fullscreen API
  const r = await win.webContents.executeJavaScript(`(async () => {
    const el = document.createElement('div');
    el.className = 'tile has-video';
    document.body.appendChild(el);
    try { await el.requestFullscreen(); } catch (e) { return { ok: false, name: e.name, message: e.message }; }
    await new Promise(r => setTimeout(r, 300));
    const ok = document.fullscreenElement === el;
    document.exitFullscreen();
    return { ok };
  })()`, true);
  console.log('RESULTADO:', JSON.stringify(r));
  app.exit(r.ok ? 0 : 1);
});
