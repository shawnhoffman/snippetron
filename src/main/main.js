const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, nativeImage, globalShortcut, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Dev: hot-reload renderer on file changes ─────────────────────────────────
const isDev = process.argv.includes('--dev');
if (isDev) {
  try {
    require('electron-reload')(path.join(__dirname, '..', 'renderer'), {
      electron: process.execPath,
      awaitWriteFinish: true,
    });
  } catch {}
}

// ─── Auto-updater (production only) ──────────────────────────────────────────
let updateAvailable = false;
let updateReady = false;
if (!isDev) {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on('update-available', () => { updateAvailable = true; updateTrayMenu(); });
    autoUpdater.on('update-downloaded', () => { updateReady = true; updateAvailable = false; updateTrayMenu(); });
  } catch {}
}

// ─── Data paths ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.snippetron');
const SNIPPETS_FILE = path.join(DATA_DIR, 'snippets.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSnippets() {
  ensureDataDir();
  if (!fs.existsSync(SNIPPETS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8')); }
  catch { return []; }
}

function saveSnippets(snippets) {
  ensureDataDir();
  fs.writeFileSync(SNIPPETS_FILE, JSON.stringify(snippets, null, 2));
}

function loadPrefs() {
  ensureDataDir();
  const defaults = { trigger: '::', launchAtLogin: false };
  if (!fs.existsSync(PREFS_FILE)) return defaults;
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }; }
  catch { return defaults; }
}

function savePrefs(prefs) {
  ensureDataDir();
  fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

// ─── App state ────────────────────────────────────────────────────────────────
let tray = null;
let managerWindow = null;
let mergeWindow = null;
let searchWindow = null;
let snippets = loadSnippets();
let prefs = loadPrefs();
let typedBuffer = '';
let uiohook = null;

// ─── Rich text clipboard ──────────────────────────────────────────────────────
function writeRichClipboard(html, plainText) {
  // Write HTML for web apps, RTF for desktop apps
  // Electron's clipboard supports both simultaneously
  const rtf = htmlToRtf(html);
  clipboard.write({
    text: plainText,
    html: html,
    rtf: rtf
  });
}

function htmlToRtf(html) {
  // Build an RTF string from HTML — handles bold, italic, underline, links, line breaks
  let rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 ';

  // Strip tags we'll handle manually
  let text = html
    .replace(/<br\s*\/?>/gi, '\\line ')
    .replace(/<\/p>/gi, '\\par ')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '{\\b $1}')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '{\\b $1}')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '{\\i $1}')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '{\\i $1}')
    .replace(/<u[^>]*>(.*?)<\/u>/gi, '{\\ul $1}')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li[^>]*>/gi, '\\bullet\\tab ')
    .replace(/<\/li>/gi, '\\par ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  rtf += text + '}';
  return rtf;
}

function htmlToPlain(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

// ─── Merge field handling ─────────────────────────────────────────────────────
function extractMergeFields(html, subject = '') {
  const combined = html + ' ' + subject;
  const regex = /\{(\w+)\}/g;
  const fields = [];
  let match;
  while ((match = regex.exec(combined)) !== null) {
    if (!fields.includes(match[1])) fields.push(match[1]);
  }
  return fields;
}

function applyMergeValues(html, values, subject = '') {
  let resultHtml = html;
  let resultSubject = subject;
  for (const [key, val] of Object.entries(values)) {
    const re = new RegExp(`\\{${key}\\}`, 'g');
    resultHtml = resultHtml.replace(re, val);
    resultSubject = resultSubject.replace(re, val);
  }
  return { html: resultHtml, subject: resultSubject };
}

// ─── Snippet expansion ────────────────────────────────────────────────────────
function trackUsage(snippetId) {
  const idx = snippets.findIndex(s => s.id === snippetId);
  if (idx < 0) return;
  snippets[idx].useCount = (snippets[idx].useCount || 0) + 1;
  snippets[idx].lastUsed = new Date().toISOString();
  saveSnippets(snippets);
  if (managerWindow) managerWindow.webContents.send('snippets-updated', snippets);
}

function expandSnippet(snippet) {
  trackUsage(snippet.id);
  const fields = extractMergeFields(snippet.html, snippet.subject || '');

  if (fields.length > 0) {
    showMergeWindow(snippet, fields);
  } else {
    pasteSnippet(snippet.html, snippet.subject || '');
  }
}

function pasteSnippet(html, subject = '') {
  const plain = htmlToPlain(html);
  writeRichClipboard(html, plain);

  // Small delay to let the clipboard settle, then simulate Cmd+V
  setTimeout(() => {
    const { execSync } = require('child_process');
    try {
      // Use AppleScript to paste — most reliable cross-app method on macOS
      execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    } catch (e) {
      console.error('Paste failed:', e);
    }

    // If snippet has a subject, overwrite clipboard with it after the body has been pasted
    if (subject && subject.trim()) {
      setTimeout(() => {
        clipboard.writeText(subject.trim());
        // Native macOS notification — visible even when the app window is hidden
        const { Notification } = require('electron');
        new Notification({
          title: 'Subject copied',
          body: subject.trim(),
          subtitle: '⌘V to paste in the subject field',
          silent: true,
        }).show();
      }, 150);
    }
  }, 80);
}

// ─── Global keyboard hook ─────────────────────────────────────────────────────
const KEY_MAP = {
  // uiohook keycodes → characters
  30: 'a', 48: 'b', 46: 'c', 32: 'd', 18: 'e', 33: 'f', 34: 'g', 35: 'h',
  23: 'i', 36: 'j', 37: 'k', 38: 'l', 50: 'm', 49: 'n', 24: 'o', 25: 'p',
  16: 'q', 19: 'r', 31: 's', 20: 't', 22: 'u', 47: 'v', 17: 'w', 45: 'x',
  21: 'y', 44: 'z',
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
  39: ';', 40: ';', 41: '`', 26: '[', 27: ']', 43: ',', 51: '.', 52: '/',
  57: ' ', 12: '-', 13: '=', 53: '\\',
};

const SEMICOLON_CODE = 39; // ; key
const COLON_SHIFT = true;

function startKeyboardHook() {
  try {
    const { UiohookKey, uIOhook } = require('uiohook-napi');
    uiohook = uIOhook;

    uIOhook.on('keydown', (e) => {
      // Backspace clears buffer
      if (e.keycode === 14) {
        typedBuffer = typedBuffer.slice(0, -1);
        return;
      }

      // Space: check for snippet match first, then reset buffer
      if (e.keycode === 57) {
        checkForTrigger(true); // space is the terminator that confirms expansion
        typedBuffer = '';
        return;
      }

      // Enter resets buffer without expanding
      if (e.keycode === 28) {
        typedBuffer = '';
        return;
      }

      const char = resolveChar(e);
      if (!char) return;

      typedBuffer += char;

      // Keep buffer at 60 chars max
      if (typedBuffer.length > 60) typedBuffer = typedBuffer.slice(-60);
    });

    uIOhook.start();
    console.log('Keyboard hook started');
  } catch (err) {
    console.error('Failed to start keyboard hook (accessibility permission needed):', err.message);
  }
}

function resolveChar(e) {
  const lower = KEY_MAP[e.keycode];
  if (!lower) return null;
  // Approximate shift — good enough for trigger detection
  if (e.shiftKey) {
    const shiftMap = {
      ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '[': '{', ']': '}',
      '`': '~', '-': '_', '=': '+', '1': '!', '2': '@', '3': '#', '4': '$',
      '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    };
    return shiftMap[lower] || lower.toUpperCase();
  }
  return lower;
}

function checkForTrigger(spaceTerminated = false) {
  if (!spaceTerminated) return; // expansion only fires when space is typed after shortcut
  const trigger = prefs.trigger || '::';
  const idx = typedBuffer.lastIndexOf(trigger);
  if (idx === -1) return;

  const afterTrigger = typedBuffer.slice(idx + trigger.length);

  if (!/^\w+$/.test(afterTrigger)) return;

  const match = snippets.find(s => s.shortcut.toLowerCase() === afterTrigger.toLowerCase());
  if (!match) return;

  // +1 to also erase the space the user just typed
  const charsToDelete = trigger.length + afterTrigger.length + 1;
  typedBuffer = '';

  const { execSync } = require('child_process');
  try {
    // Send backspaces to erase the typed text
    const script = `
      tell application "System Events"
        repeat ${charsToDelete} times
          key code 51
        end repeat
      end tell
    `;
    execSync(`osascript -e '${script}'`);
  } catch (e) {
    console.error('Backspace failed:', e);
  }

  setTimeout(() => expandSnippet(match), 100);
}

// ─── Windows ──────────────────────────────────────────────────────────────────
function createManagerWindow(focusSearch = false) {
  if (managerWindow) {
    managerWindow.show();
    managerWindow.focus();
    if (focusSearch) managerWindow.webContents.send('focus-search');
    return;
  }

  managerWindow = new BrowserWindow({
    width: 900,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  });

  managerWindow.loadFile(path.join(__dirname, '../renderer/manager.html'));
  managerWindow.once('ready-to-show', () => {
    managerWindow.show();
    if (focusSearch) managerWindow.webContents.send('focus-search');
  });
  managerWindow.on('closed', () => { managerWindow = null; });
}

function showMergeWindow(snippet, fields) {
  if (mergeWindow) mergeWindow.close();

  mergeWindow = new BrowserWindow({
    width: 420,
    height: 320 + fields.length * 56,
    resizable: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  });

  mergeWindow.loadFile(path.join(__dirname, '../renderer/merge.html'));
  mergeWindow.once('ready-to-show', () => {
    mergeWindow.webContents.send('init', { snippet, fields });
    mergeWindow.show();
  });
  mergeWindow.on('closed', () => { mergeWindow = null; });
}

function showSearchWindow() {
  if (searchWindow) {
    searchWindow.focus();
    return;
  }

  // Position near top-center of screen
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;

  searchWindow = new BrowserWindow({
    width: 580,
    height: 480,
    x: Math.round(width / 2 - 290),
    y: 80,
    resizable: false,
    alwaysOnTop: true,
    titleBarStyle: 'hidden',
    vibrancy: 'under-window',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    show: false,
  });

  searchWindow.loadFile(path.join(__dirname, '../renderer/search.html'));
  searchWindow.once('ready-to-show', () => searchWindow.show());
  searchWindow.on('closed', () => { searchWindow = null; });
  searchWindow.on('blur', () => { if (searchWindow) searchWindow.close(); });
}

// ─── Tray
function createTray() {
  // "Template" in filename → Electron auto-sets template mode (macOS light/dark tinting)
  // "@2x" variant auto-discovered → correct Retina scaling (44px shown at 22pt)
  const trayIconPath = path.join(__dirname, '..', '..', 'assets', 'tray-iconTemplate.png');
  let icon;
  if (fs.existsSync(trayIconPath)) {
    icon = nativeImage.createFromPath(trayIconPath);
  } else {
    icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
    tray = new Tray(icon);
    tray.setTitle("⚡⚡");
    tray.setToolTip("Snippetron");
    updateTrayMenu();
    return;
  }
  tray = new Tray(icon);
  tray.setToolTip("Snippetron");
  updateTrayMenu();
}

function updateTrayMenu() {
  const items = [];

  if (updateReady) {
    items.push({ label: '🔄 Restart to apply update', click: () => { const { autoUpdater } = require('electron-updater'); autoUpdater.quitAndInstall(); } });
    items.push({ type: 'separator' });
  } else if (updateAvailable) {
    items.push({ label: '⬇ Downloading update…', enabled: false });
    items.push({ type: 'separator' });
  }

  items.push(
    {
      label: 'Open Snippetron',
      accelerator: prefs.hotkey || 'CmdOrCtrl+Shift+Space',
      click: () => createManagerWindow(true),
    },
    { type: 'separator' },
    {
      label: 'Manage Snippets',
      click: () => createManagerWindow(false),
    },
    { type: 'separator' },
    {
      label: `Trigger: "${prefs.trigger || '::'}"`,
      enabled: false,
    },
    {
      label: `${snippets.length} snippet${snippets.length !== 1 ? 's' : ''}`,
      enabled: false,
    },
    { type: 'separator' }
  );

  if (isDev) {
    items.push({ label: 'Restart App', click: () => { app.relaunch(); app.exit(0); } });
  }

  items.push({ label: 'Quit Snippetron', click: () => app.quit() });

  const menu = Menu.buildFromTemplate(items);
  tray.setContextMenu(menu);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-snippets', () => snippets);
ipcMain.handle('get-prefs', () => prefs);

ipcMain.handle('save-snippet', (_, snippet) => {
  const idx = snippets.findIndex(s => s.id === snippet.id);
  if (idx >= 0) snippets[idx] = snippet;
  else snippets.push(snippet);
  saveSnippets(snippets);
  updateTrayMenu();
  // Notify search window if open
  if (searchWindow) searchWindow.webContents.send('snippets-updated', snippets);
  return true;
});

ipcMain.handle('delete-snippet', (_, id) => {
  snippets = snippets.filter(s => s.id !== id);
  saveSnippets(snippets);
  updateTrayMenu();
  return true;
});

ipcMain.handle('save-prefs', (_, newPrefs) => {
  prefs = { ...prefs, ...newPrefs };
  savePrefs(prefs);
  updateTrayMenu();
  return true;
});

ipcMain.handle('paste-snippet', (_, html, subject = '') => {
  if (searchWindow) searchWindow.close();
  setTimeout(() => pasteSnippet(html, subject), 150);
  return true;
});

ipcMain.handle('quick-paste', (_, html, subject = '') => {
  const fields = extractMergeFields(html, subject);
  if (fields.length > 0) {
    // Merge fields: show merge window (manager stays in background)
    showMergeWindow({ html, subject }, fields);
    return true;
  }
  app.hide(); // Return focus to the previous app before pasting
  setTimeout(() => pasteSnippet(html, subject), 200);
  return true;
});

ipcMain.handle('hide-manager', () => {
  app.hide();
  return true;
});

ipcMain.handle('track-usage', (_, snippetId) => {
  trackUsage(snippetId);
  return true;
});

ipcMain.handle('check-hotkey', (_, accelerator) => {
  try {
    const ok = globalShortcut.register(accelerator, () => {});
    if (ok) { globalShortcut.unregister(accelerator); return 'available'; }
    return 'taken';
  } catch { return 'invalid'; }
});

ipcMain.handle('copy-snippet', (_, html) => {
  const plain = htmlToPlain(html);
  writeRichClipboard(html, plain);
  return true;
});

ipcMain.handle('suspend-hotkey', () => {
  try { globalShortcut.unregister(prefs.hotkey || 'CmdOrCtrl+Shift+Space'); } catch {}
  return true;
});

ipcMain.handle('resume-hotkey', () => {
  const acc = prefs.hotkey || 'CmdOrCtrl+Shift+Space';
  try {
    if (!globalShortcut.isRegistered(acc)) {
      globalShortcut.register(acc, () => createManagerWindow(true));
    }
  } catch {}
  return true;
});

ipcMain.handle('save-hotkey', (_, accelerator) => {
  try {
    globalShortcut.unregister(prefs.hotkey || 'CmdOrCtrl+Shift+Space');
    const ok = globalShortcut.register(accelerator, () => createManagerWindow(true));
    if (!ok) {
      // Re-register old one if new one failed
      globalShortcut.register(prefs.hotkey || 'CmdOrCtrl+Shift+Space', () => createManagerWindow(true));
      return false;
    }
    prefs = { ...prefs, hotkey: accelerator };
    savePrefs(prefs);
    updateTrayMenu();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('merge-submit', (_, { snippet, values }) => {
  const { html: finalHtml, subject: finalSubject } = applyMergeValues(snippet.html, values, snippet.subject || '');
  if (mergeWindow) mergeWindow.close();
  setTimeout(() => pasteSnippet(finalHtml, finalSubject), 100);
  return true;
});

ipcMain.handle('merge-cancel', () => {
  if (mergeWindow) mergeWindow.close();
  return true;
});

ipcMain.handle('export-snippets', async () => {
  const { filePath } = await dialog.showSaveDialog({
    defaultPath: 'snippets.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (filePath) fs.writeFileSync(filePath, JSON.stringify(snippets, null, 2));
  return true;
});

ipcMain.handle('import-snippets', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (!filePaths.length) return false;
  try {
    const imported = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (Array.isArray(imported)) {
      // Merge — skip duplicates by id
      const existingIds = new Set(snippets.map(s => s.id));
      const newOnes = imported.filter(s => !existingIds.has(s.id));
      snippets = [...snippets, ...newOnes];
      saveSnippets(snippets);
      updateTrayMenu();
      return newOnes.length;
    }
  } catch { return false; }
  return false;
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.dock.hide(); // Menu bar app — no dock icon

  createTray();
  startKeyboardHook();

  // Global shortcut — open manager and jump to search
  globalShortcut.register(prefs.hotkey || 'CmdOrCtrl+Shift+Space', () => createManagerWindow(true));

  // Open manager on first launch if no snippets
  if (snippets.length === 0) {
    setTimeout(createManagerWindow, 500);
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when all windows are closed — stay in menu bar
  e.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (uiohook) {
    try { uiohook.stop(); } catch {}
  }
});
