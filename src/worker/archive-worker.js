'use strict';
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const fs = require('fs');

let addon = null;
try {
  addon = require(workerData.addonPath);
} catch (e) {
  // Javi grešku prvom operacijom umjesto da pukne cijela nit
  addon = null;
  parentPort.postMessage({ type: 'log', message: 'Native modul nije učitan: ' + e.message });
}

let cancelView = null;

function walkDir(absRoot, relRoot) {
  const out = [];
  const stack = [{ abs: absRoot, rel: relRoot }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(abs); } catch { names = []; }
      for (const n of names) {
        stack.push({ abs: path.join(abs, n), rel: rel ? rel + '/' + n : n });
      }
    } else if (st.isFile()) {
      out.push({ source: abs, name: rel });
    }
  }
  return out;
}

// Pretvori listu putanja (fajlovi/folderi) u stavke arhive + ukupnu veličinu
function expandInputs(paths) {
  let entries = [];
  for (const p of paths) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const baseName = path.basename(p);
    if (st.isDirectory()) entries = entries.concat(walkDir(p, baseName));
    else entries.push({ source: p, name: baseName });
  }
  let total = 0;
  for (const e of entries) {
    try { total += fs.statSync(e.source).size; } catch { /* ignore */ }
  }
  return { entries, total };
}

parentPort.on('message', (msg) => {
  const { id, op, args } = msg;

  if (op === 'setCancelBuffer') {
    cancelView = new Int32Array(msg.buffer);
    return;
  }

  if (!addon) {
    parentPort.postMessage({ id, ok: false, error: 'Native modul (archive_addon.node) nije pronađen. Pokreni "npm run build:native".' });
    return;
  }

  try {
    const onProgress = (processed, total, name) => {
      parentPort.postMessage({ type: 'progress', id, processed, total, name });
    };
    const cancel = cancelView; // Int32Array nad SharedArrayBuffer-om

    if (op === 'list') {
      const result = addon.list(args.path);
      parentPort.postMessage({ id, ok: true, result });

    } else if (op === 'extract') {
      const result = addon.extract(args.path, args.dest, {
        entries: args.entries || undefined,
        overwrite: args.overwrite !== false,
        total: args.total || 0,
        onProgress, cancel
      });
      parentPort.postMessage({ id, ok: true, result });

    } else if (op === 'create') {
      const { entries, total } = expandInputs(args.inputs || []);
      const result = addon.create(args.out, entries, {
        format: args.format || 'zip',
        level: (args.level != null) ? args.level : 6,
        total, onProgress, cancel
      });
      parentPort.postMessage({ id, ok: true, result });

    } else if (op === 'rewrite') {
      let add = [];
      let addTotal = 0;
      if (args.add && args.add.length) {
        const r = expandInputs(args.add);
        add = r.entries; addTotal = r.total;
      }
      const result = addon.rewrite(args.src, args.out, {
        exclude: args.exclude || [],
        add,
        level: (args.level != null) ? args.level : 6,
        total: (args.keptBytes || 0) + addTotal,
        onProgress, cancel
      });
      parentPort.postMessage({ id, ok: true, result });

    } else {
      parentPort.postMessage({ id, ok: false, error: 'Nepoznata operacija: ' + op });
    }
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: e.message || String(e) });
  }
});
