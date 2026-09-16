// Cliente WebSocket do servidor de sinalização, com reconexão automática.
(function () {
  class Signaling extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.ws = null;
      this.closedByUser = false;
      this.attempts = 0;
      this.timer = null;
    }

    connect() {
      this.closedByUser = false;
      clearTimeout(this.timer);
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this.dispatchEvent(new CustomEvent('error', { detail: e }));
        this._scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.attempts = 0;
        this.dispatchEvent(new Event('open'));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      };
      ws.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e }));
      ws.onclose = () => {
        this.ws = null;
        this.dispatchEvent(new Event('close'));
        if (!this.closedByUser) this._scheduleReconnect();
      };
    }

    _scheduleReconnect() {
      const delay = Math.min(10000, 1000 * Math.pow(1.6, this.attempts++));
      this.dispatchEvent(new CustomEvent('reconnecting', { detail: { delay, attempt: this.attempts } }));
      this.timer = setTimeout(() => this.connect(), delay);
    }

    get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

    send(obj) {
      if (this.connected) this.ws.send(JSON.stringify(obj));
    }

    close() {
      this.closedByUser = true;
      clearTimeout(this.timer);
      if (this.ws) { try { this.ws.close(); } catch {} }
      this.ws = null;
    }
  }

  window.Signaling = Signaling;
})();
