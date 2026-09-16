// Gravação da chamada: desenha todos os participantes num canvas e mixa todo o áudio.
(function () {
  class CallRecorder {
    /**
     * @param {AudioEngine} engine
     * @param {() => Array<{video: HTMLVideoElement, name: string, camOff: boolean}>} getTiles
     */
    constructor(engine, getTiles) {
      this.engine = engine;
      this.getTiles = getTiles;
      this.recorder = null;
      this.chunks = [];
      this.timer = null;
      this.sources = new Map();
      this.startedAt = 0;
    }

    get active() { return !!this.recorder && this.recorder.state !== 'inactive'; }

    start(remoteStreams) {
      const ctx = this.engine.ctx;
      this.canvas = document.createElement('canvas');
      this.canvas.width = 1280;
      this.canvas.height = 720;
      this.g = this.canvas.getContext('2d');

      // Áudio: meu microfone + meus sons (barramento) + todos os remotos
      this.dest = ctx.createMediaStreamDestination();
      this.engine.bus.connect(this.dest);
      for (const s of remoteStreams) this.addStream(s);

      const canvasStream = this.canvas.captureStream(20);
      const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...this.dest.stream.getAudioTracks()]);

      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported(m)) || '';
      this.recorder = new MediaRecorder(mixed, { mimeType: mime || undefined, videoBitsPerSecond: 3_000_000 });
      this.chunks = [];
      this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.recorder.start(1000);
      this.startedAt = Date.now();

      this.timer = setInterval(() => this._draw(), 1000 / 20);
    }

    addStream(stream) {
      if (!stream || this.sources.has(stream) || !this.dest) return;
      if (!stream.getAudioTracks().length) return;
      try {
        const src = this.engine.ctx.createMediaStreamSource(stream);
        src.connect(this.dest);
        this.sources.set(stream, src);
      } catch (e) { console.warn('Não foi possível gravar áudio remoto:', e); }
    }

    _draw() {
      const g = this.g, W = this.canvas.width, H = this.canvas.height;
      const tiles = this.getTiles();
      g.fillStyle = '#0f1115';
      g.fillRect(0, 0, W, H);
      const n = Math.max(1, tiles.length);
      const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
      const pad = 8, tw = (W - pad * (cols + 1)) / cols, th = (H - pad * (rows + 1)) / rows;

      tiles.forEach((tile, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = pad + c * (tw + pad), y = pad + r * (th + pad);
        g.fillStyle = '#1b1f27';
        g.fillRect(x, y, tw, th);
        const v = tile.video;
        if (v && !tile.camOff && v.videoWidth && v.readyState >= 2) {
          const ar = v.videoWidth / v.videoHeight;
          let dw = tw, dh = tw / ar;
          if (dh > th) { dh = th; dw = th * ar; }
          g.drawImage(v, x + (tw - dw) / 2, y + (th - dh) / 2, dw, dh);
        } else {
          g.fillStyle = '#3b4252';
          g.beginPath();
          g.arc(x + tw / 2, y + th / 2, Math.min(tw, th) * 0.18, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#fff';
          g.font = `bold ${Math.min(tw, th) * 0.16}px sans-serif`;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText((tile.name || '?').trim().charAt(0).toUpperCase(), x + tw / 2, y + th / 2);
        }
        // nome
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(x + 8, y + th - 34, Math.min(tw - 16, 14 + (tile.name || '').length * 11), 26);
        g.fillStyle = '#fff';
        g.font = '16px sans-serif';
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(tile.name || '', x + 15, y + th - 21);
      });
    }

    stop() {
      return new Promise((resolve) => {
        if (!this.recorder) return resolve(null);
        clearInterval(this.timer);
        const rec = this.recorder;
        rec.onstop = () => {
          const blob = new Blob(this.chunks, { type: rec.mimeType || 'video/webm' });
          try { this.engine.bus.disconnect(this.dest); } catch {}
          for (const src of this.sources.values()) { try { src.disconnect(); } catch {} }
          this.sources.clear();
          this.recorder = null;
          this.dest = null;
          resolve(blob);
        };
        rec.stop();
      });
    }
  }

  window.CallRecorder = CallRecorder;
})();
