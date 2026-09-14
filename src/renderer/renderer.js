'use strict';

const api = window.acmigo;

// ---- stanje ----
let archivePath = null;      // trenutno otvorena arhiva
let entries = [];            // sve stavke iz arhive (flat)
let cwd = '';                // trenutni folder (prefiks putanje) unutar arhive
const marked = new Set();    // stavke označene za brisanje (edit mod)
const toAdd = [];            // fajlovi/folderi za dodavanje (edit mod)
let editable = false;        // da li je format podržan za izmjenu (zip/7z/tar)
let currentOpId = 0;

const $ = (id) => document.getElementById(id);
const rowsEl = $('rows');
const emptyEl = $('empty');
const statusEl = $('status-text');

// ---- pomoćne ----
function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + u[i];
}
function extOf(p) {
  const b = p.split('/').pop();
  const d = b.lastIndexOf('.');
  return d > 0 ? b.slice(d + 1).toLowerCase() : '';
}
function setStatus(t) { statusEl.textContent = t; }

// ---- učitavanje/prikaz ----
async function openArchive(p) {
  archivePath = p;
  setStatus('Čitam arhivu…');
  try {
    entries = await api.list({ path: p });
  } catch (e) {
    setStatus('Greška: ' + e.message);
    alert('Ne mogu otvoriti arhivu:\n' + e.message);
    return;
  }
  cwd = '';
  marked.clear();
  toAdd.length = 0;
  const ext = extOf(p);
  editable = ['zip', 'jar', 'war', 'tar', '7z'].includes(ext);
  document.title = 'AcMigo Arhiver — ' + p.split('/').pop();
  render();
  updateButtons();
  setStatus(`${entries.length} stavki • ${fmtSize(entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0))}`);
}

// Napravi prikaz trenutnog nivoa foldera iz flat liste
function levelItems() {
  const prefix = cwd;
  const folders = new Map(); // ime -> {size, count}
  const files = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length).replace(/\/+$/,'');
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      if (e.isDir) {
        if (!folders.has(rest)) folders.set(rest, { size: 0, count: 0 });
      } else {
        files.push(e);
      }
    } else {
      const folder = rest.slice(0, slash);
      if (!folders.has(folder)) folders.set(folder, { size: 0, count: 0 });
      const f = folders.get(folder);
      if (!e.isDir) { f.size += e.size; f.count++; }
    }
  }
  return { folders, files };
}

function render() {
  rowsEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', !!archivePath);
  renderCrumbs();
  if (!archivePath) return;

  const { folders, files } = levelItems();
  const frag = document.createDocumentFragment();

  // ".." za nazad
  if (cwd) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td><div class="name-cell folder"><span class="ico">↩︎</span>..</div></td><td class="c-size"></td><td class="c-type"></td>`;
    tr.querySelector('.name-cell').onclick = () => { goUp(); };
    frag.appendChild(tr);
  }

  // folderi
  [...folders.keys()].sort((a, b) => a.localeCompare(b)).forEach((name) => {
    const info = folders.get(name);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="c-check"></td>
      <td><div class="name-cell folder"><span class="ico">📁</span>${escapeHtml(name)}</div></td>
      <td class="c-size">${info.count ? fmtSize(info.size) : ''}</td>
      <td class="c-type">Folder</td>`;
    tr.querySelector('.name-cell').onclick = () => { cwd = cwd + name + '/'; render(); };
    frag.appendChild(tr);
  });

  // fajlovi
  files.sort((a, b) => a.path.localeCompare(b.path)).forEach((e) => {
    const nm = e.path.slice(cwd.length);
    const tr = document.createElement('tr');
    if (marked.has(e.path)) tr.classList.add('marked');
    tr.dataset.path = e.path;
    tr.innerHTML = `<td class="c-check"><input type="checkbox" class="rc" /></td>
      <td><div class="name-cell"><span class="ico">📄</span>${escapeHtml(nm)}</div></td>
      <td class="c-size">${fmtSize(e.size)}</td>
      <td class="c-type">${extOf(e.path).toUpperCase() || 'Fajl'}</td>`;
    const cb = tr.querySelector('.rc');
    cb.onchange = () => { tr.classList.toggle('sel', cb.checked); updateButtons(); };
    frag.appendChild(tr);
  });

  rowsEl.appendChild(frag);
  $('check-all').checked = false;
}

function renderCrumbs() {
  const c = $('crumbs');
  c.innerHTML = '';
  if (!archivePath) return;
  const root = document.createElement('a');
  root.textContent = archivePath.split('/').pop();
  root.onclick = () => { cwd = ''; render(); };
  c.appendChild(root);
  const parts = cwd.split('/').filter(Boolean);
  let acc = '';
  parts.forEach((p) => {
    acc += p + '/';
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '  ›  ';
    c.appendChild(sep);
    const a = document.createElement('a'); a.textContent = p;
    const target = acc;
    a.onclick = () => { cwd = target; render(); };
    c.appendChild(a);
  });
}

function goUp() {
  const parts = cwd.split('/').filter(Boolean);
  parts.pop();
  cwd = parts.length ? parts.join('/') + '/' : '';
  render();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ---- selekcija ----
function selectedPaths() {
  const out = [];
  rowsEl.querySelectorAll('tr[data-path]').forEach((tr) => {
    const cb = tr.querySelector('.rc');
    if (cb && cb.checked) out.push(tr.dataset.path);
  });
  return out;
}

$('check-all').onchange = (e) => {
  rowsEl.querySelectorAll('tr[data-path] .rc').forEach((cb) => {
    cb.checked = e.target.checked;
    cb.closest('tr').classList.toggle('sel', cb.checked);
  });
  updateButtons();
};

function updateButtons() {
  const has = !!archivePath;
  const sel = selectedPaths().length;
  $('btn-extract-all').disabled = !has;
  $('btn-extract-here').disabled = !has;
  $('btn-extract-sel').disabled = !has || sel === 0;
  $('btn-add').disabled = !has || !editable;
  $('btn-del').disabled = !has || !editable || sel === 0;
  $('btn-save').disabled = !editable || (marked.size === 0 && toAdd.length === 0);
}

// ---- progres overlay ----
function showProgress(title) {
  currentOpId++;
  $('p-title').textContent = title;
  $('p-name').textContent = '';
  $('bar-fill').style.width = '0%';
  $('p-percent').textContent = '0%';
  $('p-bytes').textContent = '';
  $('overlay').classList.remove('hidden');
}
function hideProgress() { $('overlay').classList.add('hidden'); }

api.onProgress((m) => {
  if ($('overlay').classList.contains('hidden')) return;
  const pct = m.total > 0 ? Math.min(100, Math.round((m.processed / m.total) * 100)) : 0;
  $('bar-fill').style.width = pct + '%';
  $('p-percent').textContent = pct + '%';
  $('p-bytes').textContent = fmtSize(m.processed) + (m.total ? ' / ' + fmtSize(m.total) : '');
  $('p-name').textContent = m.name || '';
});

$('btn-cancel').onclick = async () => { await api.cancel(); setStatus('Otkazujem…'); };

// ---- akcije: extract ----
function totalBytesOf(paths) {
  if (!paths) return entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
  const set = new Set(paths);
  return entries.filter((e) => set.has(e.path)).reduce((a, e) => a + e.size, 0);
}

async function doExtract(dest, onlyPaths) {
  showProgress('Raspakivanje…');
  try {
    const res = await api.extract({
      path: archivePath, dest,
      entries: onlyPaths || undefined,
      total: totalBytesOf(onlyPaths)
    });
    hideProgress();
    if (res.cancelled) { setStatus('Otkazano.'); return; }
    if (!res.extracted) {
      setStatus('Raspakovano 0 stavki.');
      alert('Ništa nije raspakovano u:\n' + dest +
            '\n\nProbaj odredište u svom Home folderu i provjeri Postavke → Privatnost i sigurnost → Fajlovi i folderi.');
      return;
    }
    setStatus(`Raspakovano ${res.extracted} stavki u ${dest}`);
    api.reveal(dest);
  } catch (e) {
    hideProgress();
    setStatus('Greška: ' + e.message);
    alert('Greška pri raspakivanju:\n' + e.message);
  }
}

$('btn-extract-all').onclick = async () => {
  const dest = await api.pickDestDir();
  if (dest) doExtract(dest, null);
};
$('btn-extract-here').onclick = async () => {
  const dest = await api.dirname(archivePath);
  doExtract(dest, null);
};
$('btn-extract-sel').onclick = async () => {
  const sel = selectedPaths();
  if (!sel.length) return;
  const dest = await api.pickDestDir();
  if (dest) doExtract(dest, sel);
};

// ---- akcije: nova arhiva ----
$('btn-new').onclick = async () => {
  const inputs = await api.pickFiles();
  if (!inputs || !inputs.length) return;
  const out = await api.saveArchive('arhiva.zip');
  if (!out) return;
  showProgress('Pravim arhivu…');
  try {
    const res = await api.create({ out, inputs, format: 'zip', level: 6 });
    hideProgress();
    if (res.cancelled) setStatus('Otkazano.');
    else { setStatus('Arhiva napravljena: ' + out); openArchive(out); }
  } catch (e) {
    hideProgress();
    alert('Greška pri pravljenju arhive:\n' + e.message);
  }
};

// ---- akcije: edit (dodaj / obriši / sačuvaj) ----
$('btn-add').onclick = async () => {
  const files = await api.pickFiles();
  if (!files || !files.length) return;
  for (const f of files) toAdd.push(f);
  setStatus(`Za dodavanje: ${toAdd.length} stavki (klikni "Sačuvaj izmjene")`);
  updateButtons();
};

$('btn-del').onclick = () => {
  for (const p of selectedPaths()) marked.add(p);
  render();
  setStatus(`Označeno za brisanje: ${marked.size}`);
  updateButtons();
};

$('btn-save').onclick = async () => {
  if (!editable) return;
  const keptBytes = entries.filter((e) => !e.isDir && !marked.has(e.path)).reduce((a, e) => a + e.size, 0);
  const tmp = archivePath + '.acmigo.tmp';
  showProgress('Snimam izmjene…');
  try {
    const res = await api.rewrite({
      src: archivePath, out: tmp,
      exclude: [...marked],
      add: toAdd.slice(),
      level: 6, keptBytes
    });
    if (res.cancelled) { hideProgress(); setStatus('Otkazano.'); return; }
    await api.replaceFile(tmp, archivePath);
    hideProgress();
    setStatus('Izmjene sačuvane.');
    openArchive(archivePath);
  } catch (e) {
    hideProgress();
    alert('Greška pri snimanju izmjena:\n' + e.message);
  }
};

// ---- otvaranje ----
$('btn-open').onclick = async () => {
  const p = await api.pickArchive();
  if (p) openArchive(p);
};

api.onOpenArchive((p) => { if (p) openArchive(p); });

// ---- drag & drop ----
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('dragover'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const paths = files.map((f) => f.path).filter(Boolean);
  if (!paths.length) return;
  // Ako je jedna arhiva -> otvori; inače (ako imamo otvoren zip) dodaj kao izmjenu
  const arcExt = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'iso', 'bz2', 'xz', 'cab', 'lha', 'ar', 'cpio', 'jar', 'war'];
  if (paths.length === 1 && arcExt.includes(extOf(paths[0]))) {
    openArchive(paths[0]);
  } else if (archivePath && editable) {
    for (const p of paths) toAdd.push(p);
    setStatus(`Za dodavanje: ${toAdd.length} stavki (klikni "Sačuvaj izmjene")`);
    updateButtons();
  } else if (paths.length === 1 && arcExt.includes(extOf(paths[0]))) {
    openArchive(paths[0]);
  }
});

updateButtons();
setStatus('Spreman');
