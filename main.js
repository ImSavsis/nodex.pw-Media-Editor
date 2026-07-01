'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn } = require('child_process');

nativeTheme.themeSource = 'dark';

if (process.platform === 'win32') {
  app.setAppUserModelId('pw.nodex.media-editor');
}

/* ── paths ───────────────────────────────────────────── */
const SETTINGS_PATH  = path.join(app.getPath('userData'), 'settings.json');
const ASSET_IDX_PATH = path.join(app.getPath('userData'), 'assets-index.json');
const ICON_ICO       = path.join(__dirname, '..', 'assets', 'icon.ico');

let settings = {
  outputDir:    app.getPath('downloads'),
  projectsDir:  path.join(app.getPath('documents'), 'nodex-projects'),
  defExportFmt: 'mp3',
  defBitrate:   '320k',
  crossfade:    3,
  waveColor:    '#ffffff',
  bpmGrid:      true,
  firstRun:     true,
  assetPaths:   [],
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH))
      Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
  } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch {}
}

loadSettings();
try { fs.mkdirSync(settings.projectsDir, { recursive: true }); } catch {}

/* ── ffmpeg ──────────────────────────────────────────── */
const FFMPEG_LOCAL = path.join(app.getPath('userData'), 'ffmpeg.exe');

function getFFmpegPath() {
  // 1. bundled in installer
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // 2. previously downloaded to AppData
  if (fs.existsSync(FFMPEG_LOCAL)) return FFMPEG_LOCAL;
  // 3. ffmpeg-static (dev)
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch {}
  // 4. system PATH
  return 'ffmpeg';
}

async function ensureFFmpeg() {
  const current = getFFmpegPath();
  // test if it works
  const works = await new Promise(resolve => {
    try {
      const p = spawn(current, ['-version'], { windowsHide: true });
      p.on('close', c => resolve(c === 0));
      p.on('error', () => resolve(false));
      setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 5000);
    } catch { resolve(false); }
  });
  if (works) return current;

  // download static build to AppData
  if (mainWin) mainWin.webContents.send('ffmpeg-downloading', true);
  const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';
  const zipPath = path.join(app.getPath('temp'), 'ffmpeg-dl.zip');

  try {
    await downloadFile(FFMPEG_URL, zipPath);
    await extractFFmpegFromZip(zipPath, FFMPEG_LOCAL);
    fs.unlink(zipPath, () => {});
    if (mainWin) mainWin.webContents.send('ffmpeg-downloading', false);
    return FFMPEG_LOCAL;
  } catch (e) {
    if (mainWin) mainWin.webContents.send('ffmpeg-downloading', false);
    console.error('FFmpeg download failed:', e.message);
    return null;
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (u) => {
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(); follow(res.headers.location); return;
        }
        if (res.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => { file.close(); reject(err); });
    };
    follow(url);
  });
}

async function extractFFmpegFromZip(zipPath, destBin) {
  // Use PowerShell to extract (avoids needing extra npm package)
  const extractDir = path.join(app.getPath('temp'), 'ffmpeg-extract');
  await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${extractDir}" -Force`,
    ], { windowsHide: true });
    ps.on('close', c => c === 0 ? resolve() : reject(new Error('extract failed')));
    ps.on('error', reject);
  });
  // find ffmpeg.exe inside extracted dir
  function findBin(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { const r = findBin(full); if (r) return r; }
      else if (f.name.toLowerCase() === 'ffmpeg.exe') return full;
    }
    return null;
  }
  const found = findBin(extractDir);
  if (!found) throw new Error('ffmpeg.exe not found in archive');
  fs.copyFileSync(found, destBin);
  fs.rm(extractDir, { recursive: true, force: true }, () => {});
}

/* ── state ───────────────────────────────────────────── */
let mainWin = null;
let tray    = null;
let unsavedProject = false;  // renderer tells us when project is dirty

/* ── tray ────────────────────────────────────────────── */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'nodex.pw Media Editor', enabled: false },
    { type: 'separator' },
    { label: 'Show', click: () => { mainWin?.show(); mainWin?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON_ICO).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('nodex.pw Media Editor');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => { mainWin?.show(); mainWin?.focus(); });
    tray.on('double-click', () => { mainWin?.show(); mainWin?.focus(); });
  } catch {}
}

/* ── window ──────────────────────────────────────────── */
function createWindow(openFile) {
  mainWin = new BrowserWindow({
    width: 1320, height: 820,
    minWidth: 960, minHeight: 620,
    frame: false,
    transparent: false,
    backgroundColor: '#080808',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: ICON_ICO,
    show: false,
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    if (openFile) mainWin.webContents.send('open-project-file', openFile);
  });

  mainWin.on('maximize',   () => mainWin?.webContents.send('win-maximized'));
  mainWin.on('unmaximize', () => mainWin?.webContents.send('win-restored'));

  mainWin.on('close', async (e) => {
    if (app.isQuiting) return;
    e.preventDefault();

    if (unsavedProject) {
      // Show Windows balloon notification first
      tray?.displayBalloon({
        iconType: 'warning',
        title: 'nodex.pw Media Editor',
        content: 'Проверьте — всё ли сохранено. made by savsis with <3',
        noSound: false,
      });

      // Ask the user via native dialog
      const { response } = await dialog.showMessageBox(mainWin, {
        type: 'warning',
        buttons: ['Save & Close', 'Close without saving', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Unsaved project',
        message: 'You have unsaved changes.',
        detail: 'Do you want to save the project before closing?',
        icon: ICON_ICO,
      });

      if (response === 2) return;
      if (response === 0) {
        mainWin.webContents.send('save-project-then-close');
        return;
      }
    }

    // Hide to tray instead of closing fully
    mainWin.hide();
    tray?.displayBalloon({
      iconType: 'none',
      title: 'nodex.pw Media Editor',
      content: 'Running in the background. made by savsis with <3',
      noSound: true,
    });
  });

  mainWin.on('closed', () => { mainWin = null; });
}

/* ── .nodexproj file association (Windows CLI) ───────── */
let pendingOpenFile = null;
const cliFile = process.argv.slice(app.isPackaged ? 1 : 2)
  .find(a => a.endsWith('.nodexproj'));
if (cliFile && fs.existsSync(cliFile)) pendingOpenFile = cliFile;

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWin) mainWin.webContents.send('open-project-file', filePath);
  else pendingOpenFile = filePath;
});

/* ── IPC: window controls ────────────────────────────── */
ipcMain.on('app-version',  (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('win-minimize', () => mainWin?.minimize());
ipcMain.on('win-maximize', () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
ipcMain.on('win-close',    () => mainWin?.close());

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

/* Renderer tells us when project dirty state changes */
ipcMain.on('project-dirty', (_, dirty) => { unsavedProject = dirty; });
/* Renderer calls this after save-then-close completes */
ipcMain.on('project-saved-close', () => { app.isQuiting = true; mainWin?.close(); });

/* ── IPC: settings ───────────────────────────────────── */
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (_, patch) => {
  Object.assign(settings, patch);
  saveSettings();
  return settings;
});

/* ── IPC: dialogs ────────────────────────────────────── */
ipcMain.handle('open-file', async (_, opts = {}) => {
  const r = await dialog.showOpenDialog(mainWin, {
    properties: opts.dir ? ['openDirectory'] : ['openFile', ...(opts.multi !== false ? ['multiSelections'] : [])],
    filters: opts.filters || [
      { name: 'Audio / Video', extensions: ['mp3','flac','wav','ogg','m4a','aac','opus','webm','mp4','mkv','mov'] },
      { name: 'Image',         extensions: ['jpg','jpeg','png','gif','webp','bmp'] },
      { name: 'nodex Project', extensions: ['nodexproj'] },
      { name: 'All Files',     extensions: ['*'] },
    ],
    defaultPath: opts.defaultPath,
    title: opts.title || 'Select',
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('save-file', async (_, opts = {}) => {
  const r = await dialog.showSaveDialog(mainWin, {
    defaultPath: opts.defaultPath || path.join(settings.outputDir, opts.name || 'output.mp3'),
    filters: opts.filters || [
      { name: 'MP3',  extensions: ['mp3'] },
      { name: 'FLAC', extensions: ['flac'] },
      { name: 'WAV',  extensions: ['wav'] },
      { name: 'nodex Project', extensions: ['nodexproj'] },
    ],
    title: opts.title || 'Save',
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('read-file',       async (_, p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('write-file',      async (_, p, buf) => { fs.mkdirSync(require('path').dirname(p), {recursive:true}); fs.writeFileSync(p, Buffer.from(buf)); return true; });
ipcMain.handle('read-text-file',  async (_, p) => fs.readFileSync(p, 'utf8'));
ipcMain.handle('write-text-file', async (_, p, t) => { fs.mkdirSync(require('path').dirname(p), {recursive:true}); fs.writeFileSync(p, t, 'utf8'); return true; });
ipcMain.handle('file-exists',     (_, p) => fs.existsSync(p));
ipcMain.handle('get-file-stat',   async (_, p) => { const s = fs.statSync(p); return { size: s.size, mtime: s.mtimeMs, name: require('path').basename(p) }; });
ipcMain.handle('get-temp-dir', () => { const t = require('path').join(app.getPath('temp'), 'nodex-me'); fs.mkdirSync(t, {recursive:true}); return t; });
ipcMain.handle('list-dir', (_, d) => { try { return fs.readdirSync(d).map(f => require('path').join(d, f)); } catch { return []; } });

/* ── IPC: projects ───────────────────────────────────── */
ipcMain.handle('get-projects-dir', () => settings.projectsDir);
ipcMain.handle('set-projects-dir', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  if (!r.canceled) { settings.projectsDir = r.filePaths[0]; fs.mkdirSync(settings.projectsDir, {recursive:true}); saveSettings(); }
  return settings.projectsDir;
});
ipcMain.handle('list-projects', () => {
  try {
    return fs.readdirSync(settings.projectsDir)
      .filter(f => f.endsWith('.nodexproj'))
      .map(f => {
        const fp = path.join(settings.projectsDir, f);
        const st = fs.statSync(fp);
        let name = f.replace('.nodexproj','');
        try { const d = JSON.parse(fs.readFileSync(fp,'utf8')); name = d.name || name; } catch {}
        return { file: fp, name, mtime: st.mtimeMs };
      })
      .sort((a,b) => b.mtime - a.mtime);
  } catch { return []; }
});
ipcMain.handle('save-project', async (_, { project, saveAs }) => {
  let dest;
  if (saveAs || !project.filePath) {
    const r = await dialog.showSaveDialog(mainWin, {
      defaultPath: path.join(settings.projectsDir, (project.name || 'Untitled') + '.nodexproj'),
      filters: [{ name: 'nodex Project', extensions: ['nodexproj'] }],
      title: 'Save Project',
    });
    if (r.canceled) return null;
    dest = r.filePath;
  } else {
    dest = project.filePath;
  }
  project.filePath = dest;
  project.modified = new Date().toISOString();
  fs.writeFileSync(dest, JSON.stringify(project, null, 2), 'utf8');
  return dest;
});
ipcMain.handle('load-project', async (_, filePath) => {
  if (!filePath) {
    const r = await dialog.showOpenDialog(mainWin, {
      defaultPath: settings.projectsDir,
      filters: [{ name: 'nodex Project', extensions: ['nodexproj'] }],
      title: 'Open Project',
    });
    if (r.canceled) return null;
    filePath = r.filePaths[0];
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  data.filePath = filePath;
  return data;
});

/* ── IPC: asset scanning ─────────────────────────────── */
const AUDIO_EXTS = new Set(['mp3','flac','wav','ogg','m4a','aac','opus','webm','wma','aiff']);
const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','bmp']);
const VIDEO_EXTS = new Set(['mp4','mkv','mov','avi','wmv','m4v']);
const getExt = f => path.extname(f).slice(1).toLowerCase();

function countAssets(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) n += countAssets(full);
      else { const x = getExt(e.name); if (AUDIO_EXTS.has(x)||IMAGE_EXTS.has(x)||VIDEO_EXTS.has(x)) n++; }
    }
  } catch {}
  return n;
}

ipcMain.handle('asset-estimate', async (_, dirs) => {
  let total = 0;
  for (const d of dirs) total += countAssets(d);
  return total;
});

ipcMain.handle('asset-scan', async (event, dirs) => {
  const res = { audio: [], image: [], video: [] };
  function walk(dir) {
    try {
      for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        const x = getExt(e.name);
        if      (AUDIO_EXTS.has(x)) res.audio.push(full);
        else if (IMAGE_EXTS.has(x)) res.image.push(full);
        else if (VIDEO_EXTS.has(x)) res.video.push(full);
        const total = res.audio.length + res.image.length + res.video.length;
        if (total % 100 === 0) event.sender.send('asset-scan-progress', { audio: res.audio.length, image: res.image.length, video: res.video.length });
      }
    } catch {}
  }
  for (const d of dirs) walk(d);
  fs.writeFileSync(ASSET_IDX_PATH, JSON.stringify({ dirs, ...res, scannedAt: Date.now() }));
  settings.assetPaths = dirs;
  saveSettings();
  return res;
});

ipcMain.handle('asset-load-index',    () => { try { if (fs.existsSync(ASSET_IDX_PATH)) return JSON.parse(fs.readFileSync(ASSET_IDX_PATH,'utf8')); } catch {} return null; });
ipcMain.handle('asset-pick-folder',   async () => { const r = await dialog.showOpenDialog(mainWin, {properties:['openDirectory','multiSelections']}); return r.canceled ? null : r.filePaths; });
ipcMain.handle('get-default-asset-dirs', () => [app.getPath('music'), app.getPath('pictures'), app.getPath('downloads')]);

/* ── IPC: ffmpeg ─────────────────────────────────────── */
ipcMain.handle('ffmpeg-run', (event, args) => {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFFmpegPath(), args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => {
      stderr += d.toString();
      const m = stderr.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/g);
      if (m) event.sender.send('ffmpeg-progress', { time: m[m.length-1].replace('time=','') });
    });
    proc.on('close', c => c === 0 ? resolve({ ok: true }) : reject(new Error(stderr.slice(-800))));
    proc.on('error', reject);
  });
});

/* ── system notifications via tray ──────────────────── */
ipcMain.on('tray-notify', (_, { title, content }) => {
  tray?.displayBalloon({ iconType: 'info', title, content, noSound: true });
});

/* ── yt-dlp ──────────────────────────────────────────── */
const YTDLP_LOCAL = path.join(app.getPath('userData'), 'yt-dlp.exe');
const YTDLP_URL   = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

function getYtdlpPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'yt-dlp.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  if (fs.existsSync(YTDLP_LOCAL)) return YTDLP_LOCAL;
  return null;
}

async function ensureYtdlp() {
  const cur = getYtdlpPath();
  if (cur) {
    const ok = await new Promise(resolve => {
      try {
        const p = spawn(cur, ['--version'], { windowsHide: true });
        p.on('close', c => resolve(c === 0));
        p.on('error', () => resolve(false));
        setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 5000);
      } catch { resolve(false); }
    });
    if (ok) return cur;
  }
  if (mainWin) mainWin.webContents.send('ytdlp-downloading', true);
  try {
    await downloadFile(YTDLP_URL, YTDLP_LOCAL);
    if (mainWin) mainWin.webContents.send('ytdlp-downloading', false);
    return YTDLP_LOCAL;
  } catch (e) {
    if (mainWin) mainWin.webContents.send('ytdlp-downloading', false);
    console.error('yt-dlp download failed:', e.message);
    return null;
  }
}

ipcMain.handle('ensure-ytdlp', () => ensureYtdlp());
ipcMain.handle('get-ytdlp-path', () => getYtdlpPath());

ipcMain.handle('ytdlp-run', (event, { args, outputDir }) => {
  return new Promise((resolve, reject) => {
    const bin = getYtdlpPath();
    if (!bin) { reject(new Error('yt-dlp not found')); return; }
    const proc = spawn(bin, args, { windowsHide: true, cwd: outputDir || app.getPath('downloads') });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => {
      stdout += d.toString();
      const lines = stdout.split('\n');
      const last  = lines[lines.length - 2] || '';
      if (last.includes('%')) event.sender.send('ytdlp-progress', { line: last.trim() });
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', c => c === 0 ? resolve({ ok: true, stdout }) : reject(new Error(stderr.slice(-600) || stdout.slice(-600))));
    proc.on('error', reject);
  });
});

/* ── IPC: ffmpeg status ──────────────────────────────── */
ipcMain.handle('get-ffmpeg-status', () => {
  const p = getFFmpegPath();
  return { path: p, exists: p !== 'ffmpeg' && fs.existsSync(p) };
});
ipcMain.handle('ensure-ffmpeg', () => ensureFFmpeg());

/* ── lifecycle ───────────────────────────────────────── */
app.whenReady().then(async () => {
  createWindow(pendingOpenFile);
  createTray();
  ensureFFmpeg().catch(() => {});
  ensureYtdlp().catch(() => {});
  app.on('activate', () => { if (!mainWin) createWindow(); });
});
app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuiting = true; });
