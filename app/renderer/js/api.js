// API do servidor: requisições com resposta (call) e eventos (addEventListener por tipo) sobre o WebSocket.
(function () {
  class Api extends EventTarget {
    constructor(url) {
      super();
      this.sig = new Signaling(url);
      this.pending = new Map();
      this.seq = 0;
      this.sig.addEventListener('open', () => this.dispatchEvent(new Event('open')));
      this.sig.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('Conexão perdida.'));
        this.pending.clear();
        this.dispatchEvent(new Event('close'));
      });
      this.sig.addEventListener('reconnecting', (e) => this.dispatchEvent(new CustomEvent('reconnecting', { detail: e.detail })));
      this.sig.addEventListener('message', (e) => {
        const msg = e.detail;
        if (msg.type === 'res') {
          const p = this.pending.get(msg.reqId);
          if (!p) return;
          this.pending.delete(msg.reqId);
          clearTimeout(p.timer);
          msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || 'Erro'));
          return;
        }
        this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
        this.dispatchEvent(new CustomEvent('any', { detail: msg }));
      });
    }

    get connected() { return this.sig.connected; }
    connect() { this.sig.connect(); }
    close() { this.sig.close(); }

    send(type, payload = {}) { this.sig.send({ type, ...payload }); }

    call(type, payload = {}, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (!this.connected) return reject(new Error('Sem conexão com o servidor.'));
        const reqId = ++this.seq;
        const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error('O servidor não respondeu.')); }, timeoutMs);
        this.pending.set(reqId, { resolve, reject, timer });
        this.sig.send({ type, reqId, ...payload });
      });
    }
  }

  window.Api = Api;
})();
