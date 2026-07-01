'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /* window */
  getVersion:    () => ipcRenderer.sendSync('app-version'),
  winMin:        () => ipcRenderer.send('win-minimize'),
  winMax:        () => ipcRenderer.send('win-maximize'),
  winClose:      () => ipcRenderer.send('win-close'),
  onMaximized:   (cb) => ipcRenderer.on('win-maximized',       () => cb()),
  onRestored:    (cb) => ipcRenderer.on('win-restored',        () => cb()),
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),

  /* project dirty state */
  setDirty:      (d)  => ipcRenderer.send('project-dirty', d),
  onSaveThenClose: (cb) => ipcRenderer.on('save-project-then-close', cb),
  confirmClose:  ()   => ipcRenderer.send('project-saved-close'),

  /* notifications */
  trayNotify:    (title, content) => ipcRenderer.send('tray-notify', { title, content }),

  /* settings */
  getSettings:   ()    => ipcRenderer.invoke('get-settings'),
  saveSettings:  (p)   => ipcRenderer.invoke('save-settings', p),

  /* dialogs / fs */
  openFile:      (opts) => ipcRenderer.invoke('open-file', opts),
  saveFile:      (opts) => ipcRenderer.invoke('save-file', opts),
  readFile:      (p)    => ipcRenderer.invoke('read-file', p),
  writeFile:     (p, b) => ipcRenderer.invoke('write-file', p, b),
  readTextFile:  (p)    => ipcRenderer.invoke('read-text-file', p),
  writeTextFile: (p, t) => ipcRenderer.invoke('write-text-file', p, t),
  fileExists:    (p)    => ipcRenderer.invoke('file-exists', p),
  getFileStat:   (p)    => ipcRenderer.invoke('get-file-stat', p),
  getTempDir:    ()     => ipcRenderer.invoke('get-temp-dir'),
  listDir:       (d)    => ipcRenderer.invoke('list-dir', d),

  /* projects */
  getProjectsDir:  ()          => ipcRenderer.invoke('get-projects-dir'),
  setProjectsDir:  ()          => ipcRenderer.invoke('set-projects-dir'),
  listProjects:    ()          => ipcRenderer.invoke('list-projects'),
  saveProject:     (d)         => ipcRenderer.invoke('save-project', d),
  loadProject:     (p)         => ipcRenderer.invoke('load-project', p),
  onOpenProjectFile: (cb)      => ipcRenderer.on('open-project-file', (_, p) => cb(p)),

  /* assets */
  assetEstimate:     (dirs)  => ipcRenderer.invoke('asset-estimate', dirs),
  assetScan:         (dirs)  => ipcRenderer.invoke('asset-scan', dirs),
  assetLoadIndex:    ()      => ipcRenderer.invoke('asset-load-index'),
  assetPickFolder:   ()      => ipcRenderer.invoke('asset-pick-folder'),
  getDefaultAssetDirs: ()    => ipcRenderer.invoke('get-default-asset-dirs'),
  onAssetScanProgress: (cb)  => ipcRenderer.on('asset-scan-progress', (_, d) => cb(d)),

  /* ffmpeg */
  ffmpeg:              (args) => ipcRenderer.invoke('ffmpeg-run', args),
  ensureFFmpeg:        ()     => ipcRenderer.invoke('ensure-ffmpeg'),
  getFFmpegStatus:     ()     => ipcRenderer.invoke('get-ffmpeg-status'),
  onFfmpegProgress:    (cb)   => ipcRenderer.on('ffmpeg-progress',    (_, d) => cb(d)),
  onFfmpegDownloading: (cb)   => ipcRenderer.on('ffmpeg-downloading', (_, d) => cb(d)),

  /* yt-dlp */
  ensureYtdlp:        ()              => ipcRenderer.invoke('ensure-ytdlp'),
  getYtdlpPath:       ()              => ipcRenderer.invoke('get-ytdlp-path'),
  ytdlp:              (opts)          => ipcRenderer.invoke('ytdlp-run', opts),
  onYtdlpProgress:    (cb)            => ipcRenderer.on('ytdlp-progress',   (_, d) => cb(d)),
  onYtdlpDownloading: (cb)            => ipcRenderer.on('ytdlp-downloading',(_, d) => cb(d)),
});
