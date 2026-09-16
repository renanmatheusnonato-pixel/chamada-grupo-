// Efeitos sonoros padrão, sintetizados com Web Audio (não dependem de arquivos).
(function () {
  function noiseBuffer(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Envelope: ataque rápido e decaimento exponencial
  function env(ctx, node, t, peak, decay, attack = 0.005) {
    node.gain.setValueAtTime(0.0001, t);
    node.gain.linearRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(ctx, out, { type = 'sine', freq, freqEnd, t, dur, peak = 0.5, attack = 0.005 }) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    env(ctx, g, t, peak, dur, attack);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + attack + dur + 0.05);
  }

  function burst(ctx, out, { t, dur, peak = 0.5, filterType = 'bandpass', freq = 2000, q = 0.7, attack = 0.002 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, dur + attack + 0.05);
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    env(ctx, g, t, peak, dur, attack);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t); src.stop(t + attack + dur + 0.05);
  }

  const GENERATORS = [
    {
      name: 'Aplausos', emoji: '👏', dur: 2.6,
      build(ctx, out) {
        let t = 0;
        while (t < 2.2) {
          const fade = t < 0.3 ? t / 0.3 : t > 1.7 ? Math.max(0.1, (2.2 - t) / 0.5) : 1;
          burst(ctx, out, { t, dur: 0.04 + Math.random() * 0.03, peak: (0.25 + Math.random() * 0.4) * fade, freq: 1500 + Math.random() * 2500, q: 1.2 });
          t += 0.02 + Math.random() * 0.05;
        }
      },
    },
    {
      name: 'Risada', emoji: '😂', dur: 1.8,
      build(ctx, out) {
        // "ha ha ha ha": vogal sintética pulsada com tom caindo
        let t = 0.05;
        for (let i = 0; i < 7; i++) {
          const f = 260 - i * 12;
          const g = ctx.createGain();
          env(ctx, g, t, 0.35, 0.16, 0.02);
          for (const [mult, amp] of [[1, 1], [2, 0.5], [3, 0.35], [4, 0.2]]) {
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(f * mult, t);
            o.frequency.linearRampToValueAtTime(f * mult * 0.9, t + 0.18);
            const og = ctx.createGain(); og.gain.value = amp * 0.3;
            o.connect(og); og.connect(g);
            o.start(t); o.stop(t + 0.25);
          }
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.5;
          g.connect(bp); bp.connect(out);
          burst(ctx, out, { t, dur: 0.08, peak: 0.08, filterType: 'highpass', freq: 3000 });
          t += 0.22;
        }
      },
    },
    {
      name: 'Rufar de tambores', emoji: '🥁', dur: 2.4,
      build(ctx, out) {
        for (let t = 0; t < 1.9; t += 0.045) {
          burst(ctx, out, { t, dur: 0.05, peak: 0.5, filterType: 'lowpass', freq: 500, q: 1 });
          tone(ctx, out, { freq: 160, freqEnd: 90, t, dur: 0.06, peak: 0.25 });
        }
        // batida final + prato
        tone(ctx, out, { freq: 150, freqEnd: 60, t: 1.95, dur: 0.35, peak: 0.9 });
        burst(ctx, out, { t: 1.95, dur: 0.4, peak: 0.5, filterType: 'highpass', freq: 5000 });
      },
    },
    {
      name: 'Ba dum tss', emoji: '🤡', dur: 1.8,
      build(ctx, out) {
        tone(ctx, out, { freq: 200, freqEnd: 90, t: 0, dur: 0.25, peak: 0.9 });
        burst(ctx, out, { t: 0, dur: 0.05, peak: 0.4, filterType: 'lowpass', freq: 800 });
        tone(ctx, out, { freq: 160, freqEnd: 70, t: 0.24, dur: 0.28, peak: 0.9 });
        burst(ctx, out, { t: 0.24, dur: 0.05, peak: 0.4, filterType: 'lowpass', freq: 800 });
        burst(ctx, out, { t: 0.5, dur: 1.2, peak: 0.6, filterType: 'highpass', freq: 5500 });
      },
    },
    {
      name: 'Buzina', emoji: '📣', dur: 1.5,
      build(ctx, out) {
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
        lp.connect(out);
        for (const f of [233, 277, 349, 466]) {
          for (const det of [-6, 0, 6]) {
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(f * 0.94, 0);
            o.frequency.linearRampToValueAtTime(f, 0.12);
            o.detune.value = det;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, 0);
            g.gain.linearRampToValueAtTime(0.09, 0.08);
            g.gain.setValueAtTime(0.09, 1.1);
            g.gain.linearRampToValueAtTime(0.0001, 1.4);
            o.connect(g); g.connect(lp);
            o.start(0); o.stop(1.45);
          }
        }
      },
    },
    {
      name: 'Errou!', emoji: '❌', dur: 1.0,
      build(ctx, out) {
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const trem = ctx.createGain(); trem.gain.value = 0.5;
        const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 14;
        const lfoG = ctx.createGain(); lfoG.gain.value = 0.5;
        lfo.connect(lfoG); lfoG.connect(trem.gain); lfo.start(0); lfo.stop(0.95);
        trem.connect(lp); lp.connect(out);
        for (const f of [150, 155]) {
          const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.35, 0);
          g.gain.setValueAtTime(0.35, 0.75);
          g.gain.linearRampToValueAtTime(0.0001, 0.9);
          o.connect(g); g.connect(trem);
          o.start(0); o.stop(0.95);
        }
      },
    },
    {
      name: 'Acertou!', emoji: '✅', dur: 1.4,
      build(ctx, out) {
        tone(ctx, out, { freq: 1046, t: 0, dur: 0.6, peak: 0.4 });
        tone(ctx, out, { freq: 2093, t: 0, dur: 0.4, peak: 0.12 });
        tone(ctx, out, { freq: 1568, t: 0.18, dur: 0.9, peak: 0.4 });
        tone(ctx, out, { freq: 3136, t: 0.18, dur: 0.5, peak: 0.1 });
      },
    },
    {
      name: 'Tcharam!', emoji: '🎉', dur: 1.8,
      build(ctx, out) {
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => {
          tone(ctx, out, { type: 'triangle', freq: f, t: i * 0.09, dur: 0.3, peak: 0.3 });
        });
        for (const f of [523.25, 659.25, 783.99, 1046.5]) {
          tone(ctx, out, { type: 'triangle', freq: f, t: 0.4, dur: 1.2, peak: 0.22, attack: 0.02 });
          tone(ctx, out, { type: 'sine', freq: f * 2, t: 0.4, dur: 0.8, peak: 0.05, attack: 0.02 });
        }
        burst(ctx, out, { t: 0.4, dur: 0.6, peak: 0.15, filterType: 'highpass', freq: 6000 });
      },
    },
    {
      name: 'Moeda', emoji: '🪙', dur: 0.7,
      build(ctx, out) {
        tone(ctx, out, { type: 'square', freq: 987.77, t: 0, dur: 0.09, peak: 0.25, attack: 0.002 });
        tone(ctx, out, { type: 'square', freq: 1318.5, t: 0.08, dur: 0.5, peak: 0.25, attack: 0.002 });
      },
    },
    {
      name: 'Grilos', emoji: '🦗', dur: 2.6,
      build(ctx, out) {
        for (let c = 0; c < 4; c++) {
          const start = c * 0.65;
          for (let t = start; t < start + 0.35; t += 0.035) {
            tone(ctx, out, { freq: 4300, t, dur: 0.02, peak: 0.12, attack: 0.003 });
            tone(ctx, out, { freq: 4300 * 1.5, t, dur: 0.015, peak: 0.03, attack: 0.003 });
          }
        }
      },
    },
    {
      name: 'Suspense', emoji: '😱', dur: 2.2,
      build(ctx, out) {
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 350; lp.Q.value = 2;
        lp.connect(out);
        for (const [f, det] of [[110, 0], [110, 8], [55, 0], [164.8, -5]]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, 0);
          o.frequency.exponentialRampToValueAtTime(f * 0.5, 2.0);
          o.detune.value = det;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, 0);
          g.gain.linearRampToValueAtTime(0.25, 0.4);
          g.gain.setValueAtTime(0.25, 1.4);
          g.gain.linearRampToValueAtTime(0.0001, 2.1);
          o.connect(g); g.connect(lp);
          o.start(0); o.stop(2.15);
        }
        burst(ctx, out, { t: 0, dur: 2.0, peak: 0.1, filterType: 'lowpass', freq: 200, attack: 0.4 });
      },
    },
    {
      name: 'Whoosh', emoji: '💨', dur: 1.1,
      build(ctx, out) {
        const src = ctx.createBufferSource(); src.buffer = noiseBuffer(ctx, 1.1);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.5;
        bp.frequency.setValueAtTime(200, 0);
        bp.frequency.exponentialRampToValueAtTime(5000, 0.45);
        bp.frequency.exponentialRampToValueAtTime(400, 1.0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, 0);
        g.gain.linearRampToValueAtTime(0.9, 0.4);
        g.gain.linearRampToValueAtTime(0.0001, 1.0);
        src.connect(bp); bp.connect(g); g.connect(out);
        src.start(0); src.stop(1.05);
      },
    },
    {
      name: 'Sino', emoji: '🔔', dur: 2.2,
      build(ctx, out) {
        for (const [f, p, d] of [[660, 0.35, 1.8], [1320 * 1.01, 0.18, 1.2], [1980, 0.08, 0.7], [2640 * 1.02, 0.04, 0.4]]) {
          tone(ctx, out, { freq: f, t: 0, dur: d, peak: p, attack: 0.003 });
        }
      },
    },
  ];

  async function renderDefaultSounds(sampleRate = 44100) {
    const results = [];
    for (const gen of GENERATORS) {
      const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * gen.dur), sampleRate);
      const master = ctx.createGain(); master.gain.value = 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 6;
      master.connect(comp); comp.connect(ctx.destination);
      gen.build(ctx, master);
      const buffer = await ctx.startRendering();
      results.push({ id: 'default:' + gen.name, name: gen.name, emoji: gen.emoji, buffer, builtin: true });
    }
    return results;
  }

  window.DefaultSounds = { render: renderDefaultSounds };
})();
