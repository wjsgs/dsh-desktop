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

const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
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
    { label: '检查更新', click: () => { checkForUpdates().catch(() => {}); } },
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

/** Compare two dotted version strings; true when latest is newer. */
function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Self-update: check npm for a newer dsh core, install it, relaunch. */
async function checkForUpdates() {
  const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
  let latest, current;
  try {
    [latest, current] = await Promise.all([
      runHidden(['npm', 'view', '@deepseek-ai/dsh', 'version'], 30_000),
      runHidden(['dsh', '--version'], 30_000),
    ]);
  } catch (err) {
    dialog.showErrorBox('检查更新失败', String(err && err.message || err));
    return;
  }
  if (!isNewerVersion(latest, current)) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '检查更新',
      message: '已是最新版本',
      detail: `dsh 核心：${current}`,
    });
    return;
  }
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: '发现新版本',
    buttons: ['立即更新并重启', '稍后再说'],
    defaultId: 0,
    message: `dsh 核心有新版本：${current} → ${latest}`,
    detail: '更新需要 1-2 分钟，完成后应用会自动重启。',
  });
  if (choice.response !== 0) return;
  try {
    await runHidden(['npm', 'install', '-g', `@deepseek-ai/dsh@${latest}`], 600_000);
  } catch (err) {
    dialog.showErrorBox('更新失败', String(err && err.message || err));
    return;
  }
  app.relaunch();
  quitApp();
}

let hintShown = false;
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
