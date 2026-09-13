'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

let win = null;
let worker = null;
let msgId = 0;
const pending = new Map();
let cancelSAB = null;
let cancelView = null;
let pendingOpenFile = null; // ako Finder proslijedi fajl prije nego je prozor spreman

function addonPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked',
      'native', 'build', 'Release', 'archive_addon.node');
  }
  return path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'archive_addon.node');
}

function startWorker() {
  worker = new Worker(path.join(__dirname, '..', 'worker', 'archive-worker.js'), {
    workerData: { addonPath: addonPath() }
  });
  cancelSAB = new SharedArrayBuffer(4);
  cancelView = new Int32Array(cancelSAB);
  worker.postMessage({ id: ++msgId, op: 'setCancelBuffer', buffer: cancelSAB });

  worker.on('message', (m) => {
    if (m.type === 'progress') {
      if (win && !win.isDestroyed()) win.webContents.send('progress', m);
      return;
    }
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || 'Greška u obradi'));
    }
  });
  worker.on('error', (e) => console.error('[worker error]', e));
  worker.on('exit', (code) => { if (code !== 0) console.error('[worker exit]', code); });
}

function call(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1a1c22',
    title: 'AcMigo Arhiver',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (pendingOpenFile) {
      win.webContents.send('open-archive', pendingOpenFile);
      pendingOpenFile = null;
    }
  });
}

// Finder: "Otvori pomoću > AcMigo Arhiver"
app.on('open-file', (event, p) => {
  event.preventDefault();
  if (win && !win.isDestroyed()) {
    win.webContents.send('open-archive', p);
    win.focus();
  } else {
    pendingOpenFile = p;
  }
});

app.whenReady().then(() => {
  startWorker();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: dijalozi ----
ipcMain.handle('pick-archive', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Arhive', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'cab', 'lha', 'lzh', 'ar', 'cpio', 'xar', 'war', 'jar'] },
      { name: 'Svi fajlovi', extensions: ['*'] }
    ]
  });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});

ipcMain.handle('pick-dest-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return (r.canceled || !r.filePaths[0]) ? null : r.filePaths[0];
});

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('pick-dirs', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('save-archive', async (e, def) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: def || 'arhiva.zip' });
  return (r.canceled || !r.filePath) ? null : r.filePath;
});

// ---- IPC: operacije ----
ipcMain.handle('list', (e, args) => call('list', args));
ipcMain.handle('extract', (e, args) => { Atomics.store(cancelView, 0, 0); return call('extract', args); });
ipcMain.handle('create', (e, args) => { Atomics.store(cancelView, 0, 0); return call('create', args); });
ipcMain.handle('rewrite', (e, args) => { Atomics.store(cancelView, 0, 0); return call('rewrite', args); });
ipcMain.handle('cancel', () => { if (cancelView) Atomics.store(cancelView, 0, 1); return true; });

ipcMain.handle('replace-file', (e, { src, dst }) => {
  fs.renameSync(src, dst);
  return true;
});

ipcMain.handle('reveal', (e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('dirname', (e, p) => path.dirname(p));
ipcMain.handle('basename', (e, p) => path.basename(p));
