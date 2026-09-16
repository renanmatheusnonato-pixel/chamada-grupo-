// Armazena os sons enviados pelo usuário (IndexedDB) e as configurações (localStorage).
(function () {
  const DB_NAME = 'chamada-grupo';
  const STORE = 'sounds';

  const SoundStore = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          }
        };
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    },
    async all() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },
    async add(record) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).add(record);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async remove(id) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
  };

  const SETTINGS_KEY = 'cg.settings';
  const Settings = {
    load(defaults) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
      return { ...defaults, ...saved };
    },
    save(obj) {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch {}
    },
  };

  window.SoundStore = SoundStore;
  window.Settings = Settings;
})();
