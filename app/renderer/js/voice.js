// Sessão de voz/vídeo de um canal: conexões WebRTC em malha, câmera, tela, gravação.
// Não mexe na interface — emite 'update' e a UI redesenha a partir de getTiles().
(function () {
  class VoiceSession extends EventTarget {
    /**
     * @param {{api: Api, engine: AudioEngine, me: {id:string,name:string,color:string}, channel: string, rtcConfig: () => RTCConfiguration}} opts
     */
    constructor({ api, engine, me, channel, rtcConfig }) {
      super();
      this.api = api;
      this.engine = engine;
      this.me = me;
      this.channel = channel;
      this.rtcConfig = rtcConfig;
      this.peers = new Map();
      this.camTrack = null;
      this.muted = false;
      this.camOff = true;
      this.sharing = false;
      this.screenStream = null;
      this.screenAudioOff = null;
      this.recorder = null;
      this.recStartedAt = 0;
      this.startedAt = Date.now();
      this.closed = false;
      this.outStream = new MediaStream([engine.outputTrack]);
      this.localVideo = document.createElement('video');
      this.localVideo.autoplay = true; this.localVideo.muted = true; this.localVideo.playsInline = true;
      // Elementos de áudio dos remotos ficam num contêiner oculto para tocarem sempre
      this.mediaBox = document.getElementById('voiceMedia');
    }

    emit() { this.dispatchEvent(new Event('update')); }

    async join() {
      const { peers } = await this.api.call('voice-join', { channel: this.channel });
      for (const p of peers) this.createPeer(p.id, p.name, p.color, true, p.avatar);
      this.emit();
    }

    // Eventos vindos do servidor relacionados a esta sala
    onServer(msg) {
      switch (msg.type) {
        case 'voice-peer-joined': this.createPeer(msg.id, msg.name, msg.color, false, msg.avatar); this.broadcastState(); this.emit(); break;
        case 'voice-peer-left': this.removePeer(msg.id); this.emit(); break;
        case 'signal': this.handleSignal(msg.from, msg.data); break;
        case 'voice-meta': { const p = this.peers.get(msg.from); if (p) { p.state = { ...p.state, ...msg.state }; this.refreshPeerVideo(p); this.emit(); } break; }
      }
    }

    createPeer(id, name, color, initiator, avatar = null) {
      if (this.peers.has(id)) return this.peers.get(id);
      const pc = new RTCPeerConnection(this.rtcConfig());
      const peer = {
        id, name, color, avatar, pc, initiator,
        polite: this.me.id < id,
        makingOffer: false, ignoreOffer: false,
        stream: new MediaStream(),
        videoSender: null,
        state: { muted: false, camOff: true, sharing: false },
        hasVideo: false,
        conn: 'connecting',
        video: document.createElement('video'),
        audio: document.createElement('audio'),
      };
      peer.video.autoplay = true; peer.video.muted = true; peer.video.playsInline = true;
      peer.audio.autoplay = true;
      this.mediaBox?.appendChild(peer.audio);
      this.peers.set(id, peer);

      for (const track of this.outStream.getTracks()) {
        const sender = pc.addTrack(track, this.outStream);
        if (track.kind === 'video') peer.videoSender = sender;
      }
      pc.createDataChannel('keepalive');

      pc.onnegotiationneeded = async () => {
        // A primeira oferta é sempre de quem entrou por último (evita colisão); depois qualquer lado renegocia.
        if (!peer.initiator && !pc.remoteDescription) return;
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          this.api.send('signal', { to: id, data: { description: pc.localDescription } });
        } catch (e) { console.error(e); }
        finally { peer.makingOffer = false; }
      };
      pc.onicecandidate = ({ candidate }) => this.api.send('signal', { to: id, data: { candidate } });
      pc.ontrack = ({ track, streams }) => {
        const stream = streams[0] || peer.stream;
        if (!streams[0]) peer.stream.addTrack(track);
        peer.stream = stream;
        if (peer.audio.srcObject !== stream) peer.audio.srcObject = stream;
        if (peer.video.srcObject !== stream) peer.video.srcObject = stream;
        if (track.kind === 'video') {
          const refresh = () => { this.refreshPeerVideo(peer); this.emit(); };
          track.onmute = refresh; track.onunmute = refresh; track.onended = refresh;
          refresh();
        }
        if (track.kind === 'audio' && this.recorder?.active) this.recorder.addStream(stream);
        this.emit();
      };
      pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
      pc.onconnectionstatechange = () => {
        peer.conn = pc.connectionState;
        if (pc.connectionState === 'failed') this.dispatchEvent(new CustomEvent('error', { detail: `Conexão com ${peer.name} falhou. Verifique o servidor TURN nas configurações.` }));
        this.emit();
      };
      return peer;
    }

    refreshPeerVideo(peer) {
      const vt = peer.stream.getVideoTracks()[0];
      const live = !!vt && !vt.muted && vt.readyState === 'live';
      peer.hasVideo = live && (peer.state.sharing || !peer.state.camOff);
    }

    async handleSignal(from, data) {
      const peer = this.peers.get(from) || this.createPeer(from, 'Participante', '#888', false);
      const pc = peer.pc;
      try {
        if (data.description) {
          const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(data.description);
          if (data.description.type === 'offer') {
            await pc.setLocalDescription();
            this.api.send('signal', { to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate !== undefined) {
          try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
        }
      } catch (e) { console.error('Erro de sinalização:', e); }
    }

    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      try { p.pc.close(); } catch {}
      p.audio.srcObject = null; p.audio.remove();
      p.video.srcObject = null;
      this.peers.delete(id);
    }

    broadcastState() {
      this.api.send('voice-meta', { state: { muted: this.muted, camOff: this.camOff, sharing: this.sharing } });
    }

    // ---------- Controles locais ----------
    setMuted(m) { this.muted = m; this.engine.setMuted(m); this.broadcastState(); this.emit(); }

    async setCamera(track) {
      // track = null desliga; track novo liga (renegocia se ainda não havia vídeo)
      this.camTrack = track;
      this.camOff = !track;
      if (!this.sharing) {
        await this.setOutgoingVideo(track);
        this.localVideo.srcObject = track ? new MediaStream([track]) : null;
      }
      this.broadcastState(); this.emit();
    }

    async setOutgoingVideo(track) {
      for (const peer of this.peers.values()) {
        if (peer.videoSender) await peer.videoSender.replaceTrack(track).catch(console.error);
        else if (track) peer.videoSender = peer.pc.addTrack(track, this.outStream);
      }
      const old = this.outStream.getVideoTracks()[0];
      if (old && old !== track) this.outStream.removeTrack(old);
      if (track && !this.outStream.getVideoTracks().includes(track)) this.outStream.addTrack(track);
    }

    async startShare() {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: true,
      });
      const track = stream.getVideoTracks()[0];
      this.screenStream = stream;
      this.sharing = true;
      track.onended = () => this.stopShare();
      await this.setOutgoingVideo(track);
      const audio = stream.getAudioTracks()[0];
      if (audio) this.screenAudioOff = this.engine.addExternalInput(new MediaStream([audio]), 0.8);
      this.localVideo.srcObject = new MediaStream([track]);
      this.broadcastState(); this.emit();
    }

    async stopShare() {
      if (!this.sharing) return;
      this.sharing = false;
      this.screenStream?.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
      this.screenAudioOff?.(); this.screenAudioOff = null;
      await this.setOutgoingVideo(this.camTrack || null);
      this.localVideo.srcObject = this.camTrack ? new MediaStream([this.camTrack]) : null;
      this.broadcastState(); this.emit();
    }

    // ---------- Gravação ----------
    get recording() { return !!this.recorder?.active; }
    startRecording() {
      this.recorder = new CallRecorder(this.engine, () => this.getTiles().map((t) => ({ video: t.video, name: t.name, camOff: !t.hasVideo })));
      this.recorder.start([...this.peers.values()].map((p) => p.stream));
      this.recStartedAt = Date.now();
      this.emit();
    }
    async stopRecording() {
      const blob = await this.recorder.stop();
      this.recorder = null;
      this.emit();
      return blob;
    }

    getTiles() {
      const tiles = [{
        id: this.me.id, name: this.me.name, color: this.me.color, avatar: this.me.avatar || null, isLocal: true, video: this.localVideo,
        hasVideo: this.sharing || (!this.camOff && !!this.camTrack), sharing: this.sharing, muted: this.muted, conn: 'connected',
      }];
      for (const p of this.peers.values()) {
        tiles.push({ id: p.id, name: p.name, color: p.color, avatar: p.avatar, isLocal: false, video: p.video, hasVideo: p.hasVideo, sharing: p.state.sharing, muted: p.state.muted, conn: p.conn });
      }
      return tiles;
    }

    async leave() {
      if (this.closed) return;
      this.closed = true;
      if (this.recording) { try { await this.stopRecording(); } catch {} }
      await this.stopShare().catch(() => {});
      for (const id of [...this.peers.keys()]) this.removePeer(id);
      this.localVideo.srcObject = null;
      this.api.send('voice-leave');
      this.emit();
    }
  }

  window.VoiceSession = VoiceSession;
})();
