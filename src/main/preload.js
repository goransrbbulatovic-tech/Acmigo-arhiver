'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('acmigo', {
  pickArchive: () => ipcRenderer.invoke('pick-archive'),
  pickDestDir: () => ipcRenderer.invoke('pick-dest-dir'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickDirs: () => ipcRenderer.invoke('pick-dirs'),
  saveArchive: (def) => ipcRenderer.invoke('save-archive', def),

  list: (args) => ipcRenderer.invoke('list', args),
  extract: (args) => ipcRenderer.invoke('extract', args),
  create: (args) => ipcRenderer.invoke('create', args),
  rewrite: (args) => ipcRenderer.invoke('rewrite', args),
  cancel: () => ipcRenderer.invoke('cancel'),
  replaceFile: (src, dst) => ipcRenderer.invoke('replace-file', { src, dst }),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  dirname: (p) => ipcRenderer.invoke('dirname', p),
  basename: (p) => ipcRenderer.invoke('basename', p),

  onProgress: (cb) => ipcRenderer.on('progress', (e, m) => cb(m)),
  onOpenArchive: (cb) => ipcRenderer.on('open-archive', (e, p) => cb(p))
});
