// IndexedDB：持久化基准测试结果与帧样本。

const DB_NAME = 'render-bench';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('runs')) {
        db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('samples')) {
        db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export function saveRun(db, run) {
  return tx(db, 'runs', 'readwrite', (s) => s.add({ ...run, ts: Date.now() }));
}

export function saveSample(db, sample) {
  return tx(db, 'samples', 'readwrite', (s) => s.add({ ...sample, ts: Date.now() }));
}

export function getAllRuns(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('runs', 'readonly');
    const req = t.objectStore('runs').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function clearAll(db) {
  return Promise.all([
    tx(db, 'runs', 'readwrite', (s) => s.clear()),
    tx(db, 'samples', 'readwrite', (s) => s.clear()),
  ]);
}
