// Gera build/icon.png (512x512) e build/icon.ico a partir do logo definido em renderer/branding.js.
// Uso: npx electron build/make-icon.js   (ou: npm run icon)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const B = {};
try {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'branding.js'), 'utf8');
  const w = { BRANDING: null }; new Function('window', src)(w); Object.assign(B, w.BRANDING || {});
} catch (e) { console.warn('branding.js não lido, usando padrão:', e.message); }
const logo = B.logo || '🎥', c1 = B.accent || '#7c5cff', c2 = B.accent2 || '#ff5c8a';

const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent">
<div id="box" style="width:512px;height:512px;border-radius:120px;background:linear-gradient(135deg,${c1},${c2});display:grid;place-items:center;font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;font-size:300px;line-height:1">${logo}</div>
</body></html>`;

// Empacota um PNG num .ico (o formato aceita PNG direto para 256px+)
function pngToIco(png) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); entry.writeUInt8(0, 1); // 0 = 256px
  entry.writeUInt8(0, 2); entry.writeUInt8(0, 3); entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800)); // fontes de emoji
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname);
  fs.writeFileSync(path.join(out, 'icon.png'), img.toPNG());
  fs.writeFileSync(path.join(out, 'icon.ico'), pngToIco(img.resize({ width: 256, height: 256 }).toPNG()));
  console.log('Ícones gerados em', out);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
