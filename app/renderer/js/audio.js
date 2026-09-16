// Motor de áudio: microfone -> efeito de voz -> barramento -> (chamada + gravação)
//                 soundboard -> barramento (todo mundo ouve) + monitor local (você ouve)
(function () {
  // Pitch shifter granular (roda dentro do AudioWorklet)
  const PITCH_WORKLET = `
    class PitchShifter extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [{ name: 'pitch', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
      }
      constructor() {
        super();
        this.N = 16384;
        this.buf = new Float32Array(this.N);
        this.w = 0;
        this.n = 0;
        this.T = 2048; // tamanho do grão
      }
      process(inputs, outputs, params) {
        const input = inputs[0] && inputs[0][0];
        const output = outputs[0] && outputs[0][0];
        if (!output) return true;
        if (!input) { output.fill(0); return true; }
        const pitch = params.pitch[0];
        const T = this.T, N = this.N, buf = this.buf;
        const d0 = pitch > 1 ? (pitch - 1) * T + 2 : 2;
        for (let i = 0; i < input.length; i++) {
          buf[this.w] = input[i];
          let out = 0;
          for (let g = 0; g < 2; g++) {
            const ph = ((this.n + g * T / 2) % T) / T;
            const d = d0 + (1 - pitch) * ph * T;
            let rp = this.w - d;
            while (rp < 0) rp += N;
            const i0 = Math.floor(rp) % N, i1 = (i0 + 1) % N, frac = rp - Math.floor(rp);
            const s = buf[i0] * (1 - frac) + buf[i1] * frac;
            const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
            out += s * win;
          }
          output[i] = out;
          this.w = (this.w + 1) % N;
          this.n++;
        }
        return true;
      }
    }
    registerProcessor('pitch-shifter', PitchShifter);
  `;

  class AudioEngine {
    constructor() {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.workletOk = false;

      // Saída para a chamada (vira uma MediaStreamTrack de áudio)
      this.outDest = ctx.createMediaStreamDestination();
      this.bus = ctx.createGain();          // tudo que os outros ouvem passa por aqui
      this.bus.connect(this.outDest);

      // Monitor local (o que VOCÊ ouve dos seus próprios sons)
      this.monitor = ctx.createGain();
      this.monitor.gain.value = 0.6;
      this.monitor.connect(ctx.destination);

      // Microfone
      this.micSource = null;
      this.micGain = ctx.createGain();
      this.fxIn = ctx.createGain();
      this.fxOut = ctx.createGain();
      this.micGain.connect(this.fxIn);
      this.fxOut.connect(this.bus);
      this.fxNodes = [];
      this.currentEffect = 'none';
      this.fxIn.connect(this.fxOut);

      // Soundboard
      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = 0.8;
      this.sfxGain.connect(this.bus);
      this.sfxGain.connect(this.monitor);
      this.playing = new Set();

      // Entradas externas (ex.: áudio do compartilhamento de tela)
      this.externals = new Map();
    }

    async init() {
      try { await this.ctx.resume(); } catch {}
      try {
        const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: 'application/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        this.workletOk = true;
      } catch (e) {
        console.warn('AudioWorklet indisponível, efeitos de tom desativados:', e);
      }
      return this;
    }

    get outputTrack() { return this.outDest.stream.getAudioTracks()[0]; }

    setMicStream(stream) {
      if (this.micSource) { try { this.micSource.disconnect(); } catch {} }
      this.micSource = null;
      if (stream && stream.getAudioTracks().length) {
        this.micSource = this.ctx.createMediaStreamSource(stream);
        this.micSource.connect(this.micGain);
      }
    }

    setMuted(muted) {
      const t = this.ctx.currentTime;
      this.micGain.gain.cancelScheduledValues(t);
      this.micGain.gain.setTargetAtTime(muted ? 0 : 1, t, 0.02);
    }

    setSfxVolume(v) { this.sfxGain.gain.value = v; }
    setMonitorVolume(v) { this.monitor.gain.value = v; }

    // ---------- Efeitos de voz ----------
    static get EFFECTS() {
      return [
        { id: 'none', name: 'Normal', emoji: '🙂', desc: 'Sua voz sem alteração' },
        { id: 'grave', name: 'Grave', emoji: '🐻', desc: 'Voz mais profunda', pitch: true },
        { id: 'agudo', name: 'Agudo', emoji: '🐿️', desc: 'Voz fininha', pitch: true },
        { id: 'monstro', name: 'Monstro', emoji: '👹', desc: 'Grave e distorcido', pitch: true },
        { id: 'robo', name: 'Robô', emoji: '🤖', desc: 'Voz metálica' },
        { id: 'alien', name: 'Alien', emoji: '👽', desc: 'Agudo e modulado', pitch: true },
        { id: 'eco', name: 'Eco', emoji: '🏔️', desc: 'Repetições da voz' },
        { id: 'caverna', name: 'Caverna', emoji: '🕳️', desc: 'Reverberação grande' },
        { id: 'radio', name: 'Rádio', emoji: '📻', desc: 'Som de walkie-talkie' },
      ];
    }

    setEffect(id) {
      const def = AudioEngine.EFFECTS.find((e) => e.id === id) || AudioEngine.EFFECTS[0];
      if (def.pitch && !this.workletOk) return false;

      try { this.fxIn.disconnect(); } catch {}
      for (const n of this.fxNodes) {
        try { n.disconnect(); } catch {}
        try { if (typeof n.stop === 'function') n.stop(); } catch {}
      }
      this.fxNodes = [];
      this._buildEffect(def.id);
      this.currentEffect = def.id;
      return true;
    }

    _buildEffect(id) {
      const ctx = this.ctx, input = this.fxIn, output = this.fxOut, nodes = this.fxNodes;
      const chain = (...list) => {
        let prev = input;
        for (const n of list) { prev.connect(n); prev = n; }
        prev.connect(output);
        nodes.push(...list);
      };
      const ringMod = (hz) => {
        const ring = ctx.createGain(); ring.gain.value = 0;
        const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.value = hz;
        osc.connect(ring.gain); osc.start();
        nodes.push(osc);
        return ring;
      };
      const filter = (type, freq, q = 0.8) => {
        const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
      };
      const gain = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
      const shaper = (k) => { const s = ctx.createWaveShaper(); s.curve = this._distCurve(k); s.oversample = '2x'; return s; };

      switch (id) {
        case 'grave': chain(this._pitch(0.72)); break;
        case 'agudo': chain(this._pitch(1.45)); break;
        case 'monstro': chain(this._pitch(0.58), shaper(25), filter('lowpass', 2500), gain(0.8)); break;
        case 'robo': chain(ringMod(55), filter('bandpass', 1200, 0.6), gain(1.4)); break;
        case 'alien': chain(this._pitch(1.3), ringMod(28), gain(1.3)); break;
        case 'eco': {
          input.connect(output);
          const delay = ctx.createDelay(1); delay.delayTime.value = 0.28;
          const fb = gain(0.42), wet = gain(0.6), lp = filter('lowpass', 3000);
          input.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay);
          lp.connect(wet); wet.connect(output);
          nodes.push(delay, fb, wet, lp);
          break;
        }
        case 'caverna': {
          const dry = gain(0.7), wet = gain(0.9);
          const conv = ctx.createConvolver(); conv.buffer = this._impulse(2.8, 3);
          input.connect(dry); dry.connect(output);
          input.connect(conv); conv.connect(wet); wet.connect(output);
          nodes.push(dry, conv, wet);
          break;
        }
        case 'radio': chain(filter('highpass', 500), filter('lowpass', 2800), shaper(60), gain(0.6)); break;
        default: input.connect(output);
      }
    }

    _pitch(ratio) {
      const node = new AudioWorkletNode(this.ctx, 'pitch-shifter');
      node.parameters.get('pitch').value = ratio;
      return node;
    }

    _impulse(duration, decay) {
      const sr = this.ctx.sampleRate, len = Math.floor(sr * duration);
      const buf = this.ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    _distCurve(k) {
      const n = 8192, curve = new Float32Array(n), deg = Math.PI / 180;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
      return curve;
    }

    // ---------- Soundboard ----------
    decode(arrayBuffer) { return this.ctx.decodeAudioData(arrayBuffer); }

    playSound(buffer, onEnded) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.sfxGain);
      src.onended = () => { this.playing.delete(src); onEnded && onEnded(); };
      this.playing.add(src);
      src.start();
      return src;
    }

    stopAllSounds() {
      for (const s of this.playing) { try { s.stop(); } catch {} }
      this.playing.clear();
    }

    // ---------- Entradas externas ----------
    addExternalInput(stream, volume = 1) {
      const src = this.ctx.createMediaStreamSource(stream);
      const g = this.ctx.createGain(); g.gain.value = volume;
      src.connect(g); g.connect(this.bus);
      const key = Symbol('ext');
      this.externals.set(key, [src, g]);
      return () => {
        const pair = this.externals.get(key);
        if (!pair) return;
        for (const n of pair) { try { n.disconnect(); } catch {} }
        this.externals.delete(key);
      };
    }
  }

  window.AudioEngine = AudioEngine;
})();
