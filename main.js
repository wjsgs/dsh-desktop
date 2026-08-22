'use strict';

/**
 * DeepSeek Harness desktop shell.
 *
 * Boots the official `dsh web` server (headless HTTP), waits for it to print
 * its URL, then shows that UI in a native Electron window.
 *
 * Background behavior: closing the window hides the app into the system tray
 * (the dsh server keeps running, so restoring is instant). The app only truly
 * exits when the user picks 退出 — from the tray menu or from the taskbar
 * right-click Jump List ("任务栏右键 → 退出").
 */

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, Notification, ipcMain, shell } = require('electron');
const { spawn, execFile, execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const START_TIMEOUT_MS = 90_000;

/** Locate the dsh launcher on this machine (npm global install). */
function resolveDshCmd() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'npm', 'dsh.cmd'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'dsh'; // fall back to PATH resolution via cmd /c
}

/**
 * Start `dsh web --port 0` (OS-assigned free port) and resolve with the
 * URL once the server prints it. Rejects on exit or timeout.
 */
function startDshServer() {
  return new Promise((resolve, reject) => {
    const dshCmd = resolveDshCmd();
    const args = [dshCmd, 'web', '--port', '0'];
    const child = spawn('cmd', ['/c', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    bootChild = child; // visible to quitApp even before this promise settles

    let settled = false;
    let buf = '';

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (value && value.child === bootChild) bootChild = null;
      fn(value);
    };

    const killTree = (pid, cb) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => cb && cb());
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      // dsh prints:  dsh web: http://127.0.0.1:3080
      const m = buf.match(/https?:\/\/[^\s]+/);
      if (m) {
        const url = m[0];
        finish(resolve, { child, url });
      }
    });

    child.stderr.on('data', (chunk) => {
      buf += chunk.toString();
    });

    child.on('error', (err) => {
      finish(reject, err);
    });

    child.on('exit', (code) => {
      finish(reject, new Error(`dsh web exited early (code ${code})`));
    });

    setTimeout(() => {
      if (!settled) {
        killTree(child.pid);
        finish(reject, new Error(`Timed out waiting for dsh web to start (${START_TIMEOUT_MS}ms)`));
      }
    }, START_TIMEOUT_MS);
  });
}

/** Synchronously kill a dsh process tree (cmd + node). Blocks until done. */
function killTreeSync(child) {
  if (!child || child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* already gone */ }
  try { child.kill(); } catch { /* already gone */ }
}

let serverChild = null;
let serverPromise = null;
let bootChild = null;
let mainWindow = null;
let tray = null;
let quitting = false;

/** Bring the main window back (tray click, shortcut relaunch, Jump List). */
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

/** Real exit: tear down tray, synchronously stop dsh, then quit. */
function quitApp() {
  if (quitting) return;
  quitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  // Kill the dsh tree synchronously so no orphan survives the process exit.
  if (serverChild) {
    killTreeSync(serverChild);
  } else if (bootChild) {
    killTreeSync(bootChild);
  }
  app.quit();
}

function createTray() {
  let image = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  }
  image = image.resize({ width: 32, height: 32 });
  tray = new Tray(image);
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '检查更新', click: () => { openUpdateWindow(); } },
    { type: 'separator' },
    { label: '退出', click: quitApp },
  ]));
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

/** Run a command via cmd (npm/dsh are .cmd shims) and return trimmed stdout. */
function runHidden(args, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    execFile('cmd', ['/c', ...args], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message)));
      else resolve(stdout.trim());
    });
  });
}

/** Parse a semver string into core numbers + prerelease tag. */
function parseVer(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** Semver-aware comparison; true when latest is strictly newer than current. */
function isNewerVersion(latest, current) {
  const a = parseVer(latest);
  const b = parseVer(current);
  if (!a || !b) return false;
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] > b[k];
  }
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;  // release beats any prerelease of the same core
  if (!b.pre) return false;
  // Both prerelease: compare dotted identifiers per semver rules.
  const ai = a.pre.split('.');
  const bi = b.pre.split('.');
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = +x - +y;
      if (d !== 0) return d > 0;
    } else if (xn !== yn) {
      return yn; // numeric identifiers sort below alphanumeric ones
    } else if (x !== y) {
      return x > y;
    }
  }
  return false;
}

let updateWin = null;
let updateBusy = false;
let updateChild = null;

function sendUpdateState(state) {
  if (updateWin && !updateWin.isDestroyed()) {
    try { updateWin.webContents.send('update-state', state); } catch { /* window closing */ }
  }
}

/** The update window page: status, live npm output tail, elapsed time. */
const UPDATE_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #0f1115; color: #e6e6e6;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif; display: flex;
    flex-direction: column; padding: 22px 24px; box-sizing: border-box; user-select: none; }
  h1 { font-size: 17px; margin: 0 0 6px; }
  .ver { font-size: 13px; color: #8a93a6; margin-bottom: 14px; min-height: 18px; }
  .bar { height: 6px; border-radius: 3px; background: #232833; overflow: hidden; margin-bottom: 10px; }
  .bar > i { display: block; height: 100%; width: 40%; border-radius: 3px;
    background: linear-gradient(90deg, #2a6fdb, #4d9fff); }
  .bar.indet > i { animation: slide 1.1s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  .bar.done > i { width: 100%; margin: 0; animation: none; background: #35b268; }
  .bar.err > i { width: 100%; margin: 0; animation: none; background: #d05050; }
  .status { font-size: 14px; margin-bottom: 12px; }
  .log { flex: 1; overflow-y: auto; background: #171b23; border: 1px solid #232833;
    border-radius: 8px; padding: 10px 12px; font: 12px/1.55 Consolas, monospace;
    color: #9fb0c8; white-space: pre-wrap; word-break: break-all; }
  .row { display: flex; gap: 10px; margin-top: 14px; }
  button { flex: 1; padding: 9px 0; border: 0; border-radius: 8px; cursor: pointer;
    font-size: 13px; font-family: inherit; background: #2a6fdb; color: #fff; }
  button.ghost { background: #232833; color: #9fb0c8; }
  button:disabled { opacity: .45; cursor: default; }
</style></head>
<body>
  <h1>软件更新</h1>
  <div class="ver" id="ver"></div>
  <div class="bar indet" id="bar"><i></i></div>
  <div class="status" id="status">正在检查新版本…</div>
  <div class="log" id="log"></div>
  <div class="row" id="btns" style="display:none">
    <button class="ghost" id="close">关闭</button>
    <button id="go">开始更新</button>
  </div>
<script>
  const $ = (id) => document.getElementById(id);
  let t0 = null;
  setInterval(() => {
    if (t0 !== null) $('status').textContent = $('status').dataset.base +
      '（已用时 ' + Math.floor((Date.now() - t0) / 1000) + ' 秒）';
  }, 1000);
  window.updateApi.onState((s) => {
    if (s.ver !== undefined) $('ver').textContent = s.ver;
    if (s.log !== undefined) {
      $('log').textContent = s.log || '（等待 npm 输出…）';
      $('log').scrollTop = $('log').scrollHeight;
    }
    if (s.phase) {
      $('status').dataset.base = s.text;
      $('status').textContent = s.text + (t0 !== null && s.phase === 'installing' ?
        '（已用时 ' + Math.floor((Date.now() - t0) / 1000) + ' 秒）' : '');
      $('bar').className = 'bar ' + (s.phase === 'done' ? 'done' :
        s.phase === 'error' ? 'err' : 'indet');
      if (s.phase === 'installing' && t0 === null) t0 = Date.now();
      const show = s.phase === 'available' || s.phase === 'error';
      $('btns').style.display = show ? 'flex' : 'none';
      $('go').textContent = s.phase === 'error' ? '重试' : '开始更新';
    }
  });
  $('go').onclick = () => { t0 = null; $('btns').style.display = 'none'; window.updateApi.action('start'); };
  $('close').onclick = () => window.updateApi.action('close');
</script>
</body></html>`;

/** Open the update window and kick off the version check. */
function openUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) {
    updateWin.show();
    updateWin.focus();
    return;
  }
  updateWin = new BrowserWindow({
    width: 460,
    height: 540,
    title: '软件更新',
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'update-preload.js'),
    },
  });
  updateWin.removeMenu();
  updateWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(UPDATE_PAGE));
  updateWin.on('closed', () => { updateWin = null; });
  updateWin.webContents.on('did-finish-load', runUpdateCheck);
}

async function runUpdateCheck() {
  sendUpdateState({ phase: 'checking', text: '正在检查新版本…', log: '' });
  let latest, current;
  try {
    [latest, current] = await Promise.all([
      runHidden(['npm', 'view', '@deepseek-ai/dsh', 'version'], 30_000),
      runHidden(['dsh', '--version'], 30_000),
    ]);
  } catch (err) {
    sendUpdateState({ phase: 'error', text: '检查更新失败', log: String(err && err.message || err) });
    return;
  }
  if (!isNewerVersion(latest, current)) {
    sendUpdateState({ phase: 'uptodate', text: '已是最新版本', ver: `dsh 核心：${current}` });
    return;
  }
  updateBusy = { latest, current };
  sendUpdateState({
    phase: 'available',
    text: `发现新版本：${current} → ${latest}`,
    ver: `dsh 核心：${current} → ${latest}`,
    log: '点击「开始更新」自动安装，完成后应用会自动重启。',
  });
}

ipcMain.on('update-action', (_e, action) => {
  if (action === 'close') {
    if (updateWin && !updateWin.isDestroyed()) updateWin.close();
    return;
  }
  if (action === 'start' && updateBusy && updateChild === null) startUpdateInstall();
});

/** Stream `npm install -g` output into the update window, then relaunch. */
function startUpdateInstall() {
  const { latest } = updateBusy;
  sendUpdateState({ phase: 'installing', text: `正在安装 ${latest}…`, log: '' });
  updateChild = spawn('cmd', ['/c', 'npm', 'install', '-g', `@deepseek-ai/dsh@${latest}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = [];
  let lastSend = 0;
  const push = (chunk) => {
    const text = chunk.toString()
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\r/g, '\n');
    for (const l of text.split('\n')) {
      const t = l.trim();
      if (t) lines.push(t);
      if (lines.length > 60) lines.shift();
    }
    const now = Date.now();
    if (now - lastSend > 300) {
      lastSend = now;
      sendUpdateState({ phase: 'installing', log: lines.join('\n') });
    }
  };
  updateChild.stdout.on('data', push);
  updateChild.stderr.on('data', push);
  updateChild.on('error', (err) => {
    updateChild = null;
    sendUpdateState({ phase: 'error', text: '更新失败', log: String(err && err.message || err) });
  });
  updateChild.on('exit', (code) => {
    const child = updateChild;
    updateChild = null;
    if (code === 0) {
      sendUpdateState({ phase: 'done', text: '更新完成，正在重启…', log: lines.join('\n') });
      setTimeout(() => { app.relaunch(); quitApp(); }, 1200);
    } else {
      sendUpdateState({ phase: 'error', text: `更新失败（npm 退出码 ${code}）`, log: lines.join('\n') });
    }
    void child;
  });
}


let hintShown = false;

/** Pop a native toast and pull the window forward on click. */
function notifyUser(title, body, { clickShowsWindow = true, flash = false } = {}) {
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({ title, body: body || '' });
    if (clickShowsWindow) n.on('click', () => showMainWindow());
    n.show();
  } catch { /* best-effort */ }
  if (flash && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
    mainWindow.once('focus', () => mainWindow.flashFrame(false));
  }
}

/** Handle attention events reported by the preload observer. */
function handleAttention(event) {
  const hidden = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible();
  const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  if (event === 'question') {
    // The UI is asking for a decision: always surface it, even on top of
    // other work, because the agent is blocked until it is answered.
    console.log('[dsh-attention] question pending');
    notifyUser('DeepSeek Harness 需要你的确认', '代理正在等待你的选择，点击此处回到窗口作答。', { flash: true });
    if (hidden) showMainWindow();
  } else if (event === 'task-done') {
    // Only notify when the user is not already looking at the app.
    if (!focused) {
      console.log('[dsh-attention] task finished');
      notifyUser('任务已完成', 'DeepSeek Harness 已完成当前任务，点击查看结果。');
    }
  }
}

ipcMain.on('dsh-attention', (_event, kind) => {
  try { handleAttention(kind); } catch { /* best-effort */ }
});

function showTrayHintOnce() {
  if (hintShown || !Notification.isSupported()) return;
  hintShown = true;
  try {
    new Notification({
      title: 'DeepSeek Harness 正在后台运行',
      body: '双击托盘图标或桌面快捷方式可恢复窗口；任务栏右键可选择"退出"。',
    }).show();
  } catch { /* notification is best-effort */ }
}

/** Minimal loading splash shown immediately so the app feels responsive. */
function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: #0f1115; color: #e6e6e6;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 18px; }
  .spinner { width: 42px; height: 42px; border-radius: 50%;
    border: 4px solid #2a2f3a; border-top-color: #4d9fff;
    animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .title { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; }
  .hint { font-size: 12px; color: #8a93a6; }
</style></head>
<body>
  <div class="spinner"></div>
  <div class="title">DeepSeek Harness 正在启动</div>
  <div class="hint">正在加载插件环境，请稍候…</div>
</body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

// Single instance: relaunching the app (or the desktop shortcut) shows the
// existing window instead of spawning a second copy. The taskbar Jump List
// "退出" item relaunches with --quit, which performs the real exit.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else if (process.argv.includes('--quit')) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) quitApp();
    else showMainWindow();
  });
  // Kick off dsh boot immediately, in parallel with Electron's own init.
  serverPromise = startDshServer();
  boot();
}

function boot() {
  app.whenReady().then(() => {
    try {
      app.setAppUserModelId('com.deepseek.dsh-desktop');
      app.setUserTasks([
        { title: '显示主窗口', program: process.execPath, args: '--show', iconPath: process.execPath, iconIndex: 0 },
        { title: '退出', program: process.execPath, args: '--quit', iconPath: process.execPath, iconIndex: 0 },
      ]);
    } catch { /* jump list is best-effort */ }
    createTray();

    // Show a loading window immediately; boot dsh in parallel underneath.
    const splash = createLoadingWindow();

    (async () => {
      let url;
      try {
        const started = await serverPromise;
        serverChild = started.child;
        url = started.url;
      } catch (err) {
        dialog.showErrorBox('DeepSeek Harness 启动失败', String(err && err.message || err));
        quitApp();
        return;
      }

      mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        show: false,
        title: 'DeepSeek Harness',
        autoHideMenuBar: true,
        backgroundColor: '#0f1115',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });

      mainWindow.removeMenu();
      mainWindow.loadURL(url);

      // Swap to the real window once the UI has actually rendered, with a
      // fallback so a slow first paint never leaves the user staring at a
      // blank desktop.
      const showWhenReady = () => {
        if (!splash.isDestroyed()) splash.close();
        if (!mainWindow.isDestroyed()) mainWindow.show();
      };
      mainWindow.once('ready-to-show', showWhenReady);
      setTimeout(showWhenReady, 5000);

      // Closing the window hides the app to the tray; it keeps running.
      mainWindow.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          mainWindow.hide();
          showTrayHintOnce();
        }
      });
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    })();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('window-all-closed', () => {
    // Only reachable during a real exit: otherwise the window is hidden,
    // never closed, so the app stays resident in the tray.
    if (quitting) app.quit();
  });

  app.on('will-quit', () => {
    if (serverChild) killTreeSync(serverChild);
    else if (bootChild) killTreeSync(bootChild);
  });

  app.on('quit', () => {
    // Final safety net for a process that outlived the event handlers.
    if (serverChild) killTreeSync(serverChild);
    else if (bootChild) killTreeSync(bootChild);
  });
}
