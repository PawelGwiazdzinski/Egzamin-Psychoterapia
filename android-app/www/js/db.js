// Lokalna baza (IndexedDB): pliki, przetworzone dokumenty, metadane, notatki.
const DB_NAME = "lektor";
let dbp;

function open() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("meta", { keyPath: "id" });
      db.createObjectStore("files");   // id -> ArrayBuffer (PDF) / string (tekst)
      db.createObjectStore("docs");    // id -> {pages, sentences, lang}
      db.createObjectStore("notes", { keyPath: "id" }).createIndex("doc", "doc");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  put: (store, val, key) => tx(store, "readwrite", (s) => (key === undefined ? s.put(val) : s.put(val, key))),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  all: (store) => tx(store, "readonly", (s) => s.getAll()),
  notesOf: (doc) => tx("notes", "readonly", (s) => s.index("doc").getAll(doc)),
  async removeDoc(id) {
    for (const st of ["meta", "files", "docs"]) await this.del(st, id);
    for (const n of await this.notesOf(id)) await this.del("notes", n.id);
  },
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Date.now().toString(16)).slice(0, 12);

export const prefs = {
  get(k, d) { try { const v = localStorage.getItem("lektor." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lektor." + k, JSON.stringify(v)); } catch {} },
};
