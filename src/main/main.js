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
// SNIPPETRON_DATA_DIR lets a dev instance run against an isolated copy of the
// data, so it can't fight the installed app over the same files.
const DATA_DIR = process.env.SNIPPETRON_DATA_DIR || path.join(os.homedir(), '.snippetron');
const SNIPPETS_FILE = path.join(DATA_DIR, 'snippets.json');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
// Folders live in their own file so snippets.json stays a bare array — an older
// build of the app can still read it and keep expanding snippets.
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

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

function loadFolders() {
  ensureDataDir();
  if (!fs.existsSync(FOLDERS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8'));
    const list = Array.isArray(data) ? data : (data.folders || []);
    return list.map((f, i) => ({
      id: String(f.id),
      name: f.name || 'Folder',
      order: Number.isFinite(f.order) ? f.order : i,
      collapsed: !!f.collapsed,
      color: f.color || null,
      createdAt: f.createdAt || new Date().toISOString(),
    }));
  } catch { return []; }
}

function saveFolders(list) {
  ensureDataDir();
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify({ version: 1, folders: list }, null, 2));
}

function loadPrefs() {
  ensureDataDir();
  const defaults = { trigger: '::', launchAtLogin: false, snippetSort: 'manual', folderSort: 'manual', sidebarWidth: 240 };
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
let folders = loadFolders();
let prefs = loadPrefs();
let typedBuffer = '';

// Migrate + reconcile before anything reads the data. Declared above as function
// declarations, so calling them here is safe.
migrateSnippetOrdering();
reconcile();

// ─── Renderer notification ────────────────────────────────────────────────────
// Every mutation of `snippets` or `folders` goes through here so no window can
// drift out of sync (previously save-snippet notified only the search window and
// delete-snippet notified nobody).
function broadcast() {
  for (const w of [managerWindow, searchWindow]) {
    if (w && !w.isDestroyed()) {
      w.webContents.send('snippets-updated', snippets);
      w.webContents.send('folders-updated', folders);
    }
  }
}

// Drop keys whose value is undefined so a partial update can't blank a field.
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// ─── Folders: migration, ordering, integrity ──────────────────────────────────

// Backfill folderId + order onto records written before folders existed. Order
// comes from current array position, so the existing list keeps the exact order
// the user already sees.
function migrateSnippetOrdering() {
  const needs = snippets.some(s => s.order === undefined || s.folderId === undefined);
  if (!needs) return;
  const bak = SNIPPETS_FILE + '.bak-preFolders';
  if (fs.existsSync(SNIPPETS_FILE) && !fs.existsSync(bak)) {
    try { fs.copyFileSync(SNIPPETS_FILE, bak); } catch {}
  }
  snippets = snippets.map((s, i) => ({
    ...s,
    folderId: s.folderId === undefined ? null : s.folderId,
    order: Number.isFinite(s.order) ? s.order : i,
  }));
  saveSnippets(snippets);
}

// Any folderId with no matching folder falls back to Unorganized. Also fills in
// a missing order, so imported records from another install stay usable.
function reconcile({ persist = true } = {}) {
  const known = new Set(folders.map(f => f.id));
  let changed = false;
  for (const s of snippets) {
    if (s.folderId !== null && s.folderId !== undefined && !known.has(s.folderId)) {
      s.folderId = null;
      changed = true;
    }
    if (s.folderId === undefined) { s.folderId = null; changed = true; }
    if (!Number.isFinite(s.order)) { s.order = nextOrder(s.folderId); changed = true; }
  }
  if (reindexAll()) changed = true;
  if (changed && persist) { saveSnippets(snippets); saveFolders(folders); }
  return changed;
}

function inFolder(folderId) {
  return snippets.filter(s => (s.folderId ?? null) === (folderId ?? null));
}

function nextOrder(folderId) {
  const sibs = inFolder(folderId);
  return sibs.length ? Math.max(...sibs.map(s => s.order || 0)) + 1 : 0;
}

// Collapse each container's order values down to a dense 0..n-1 run.
function reindexAll() {
  let changed = false;
  const containers = [null, ...folders.map(f => f.id)];
  for (const c of containers) {
    inFolder(c)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((s, i) => { if (s.order !== i) { s.order = i; changed = true; } });
  }
  folders
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach((f, i) => { if (f.order !== i) { f.order = i; changed = true; } });
  return changed;
}
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
  broadcast();
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
  if (isDev && process.env.SNIPPETRON_NO_HOOK) return; // dev harness: don't fight the installed app
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
  if (!tray) return; // reachable from the auto-updater before createTray() runs
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
ipcMain.handle('get-folders', () => folders);

ipcMain.handle('create-folder', (_, name) => {
  const folder = {
    id: String(Date.now()),
    name: (name || 'New folder').trim() || 'New folder',
    order: folders.length,
    collapsed: false,
    color: null,
    createdAt: new Date().toISOString(),
  };
  folders.push(folder);
  saveFolders(folders);
  broadcast();
  return folder;
});

ipcMain.handle('rename-folder', (_, id, name) => {
  const f = folders.find(x => x.id === id);
  if (!f) return false;
  const clean = (name || '').trim();
  if (!clean) return false;
  f.name = clean;
  saveFolders(folders);
  broadcast();
  return true;
});

// Deleting a folder never deletes snippets — its children move to Unorganized.
ipcMain.handle('delete-folder', (_, id) => {
  const f = folders.find(x => x.id === id);
  if (!f) return false;
  let n = nextOrder(null);
  for (const s of inFolder(id)) { s.folderId = null; s.order = n++; }
  folders = folders.filter(x => x.id !== id);
  reindexAll();
  saveSnippets(snippets);
  saveFolders(folders);
  broadcast();
  return true;
});

// No broadcast: collapse is a per-window view preference, and echoing it back
// would re-render the list mid-interaction.
ipcMain.handle('set-folder-collapsed', (_, id, collapsed) => {
  const f = folders.find(x => x.id === id);
  if (!f) return false;
  f.collapsed = !!collapsed;
  saveFolders(folders);
  return true;
});

ipcMain.handle('set-folder-color', (_, id, color) => {
  const f = folders.find(x => x.id === id);
  if (!f) return false;
  f.color = color || null;
  saveFolders(folders);
  broadcast();
  return true;
});

// One coarse write for any rearrangement. The renderer sends its whole computed
// layout as {id, folderId, order} tuples — never full snippet bodies, so a
// concurrent trackUsage write can't be clobbered. Unknown ids are ignored, which
// makes it idempotent and safe to replay.
ipcMain.handle('apply-layout', (_, layout = {}) => {
  const known = new Set(folders.map(f => f.id));

  for (const { id, order } of layout.folders || []) {
    const f = folders.find(x => x.id === id);
    if (f && Number.isFinite(order)) f.order = order;
  }

  const byId = new Map(snippets.map(s => [s.id, s]));
  for (const { id, folderId, order } of layout.snippets || []) {
    const s = byId.get(id);
    if (!s) continue;
    if (folderId === null || known.has(folderId)) s.folderId = folderId ?? null;
    if (Number.isFinite(order)) s.order = order;
  }

  reindexAll();
  saveSnippets(snippets);
  saveFolders(folders);
  broadcast();
  return true;
});

ipcMain.handle('save-snippet', (_, snippet) => {
  const idx = snippets.findIndex(s => s.id === snippet.id);
  // Merge, never replace — the editor sends only the fields it owns, so a full
  // replace silently wiped useCount and lastUsed on every edit.
  if (idx >= 0) snippets[idx] = { ...snippets[idx], ...stripUndefined(snippet) };
  else snippets.push({ folderId: null, ...stripUndefined(snippet), order: nextOrder(snippet.folderId ?? null) });
  saveSnippets(snippets);
  updateTrayMenu();
  broadcast();
  return true;
});

ipcMain.handle('delete-snippet', (_, id) => {
  snippets = snippets.filter(s => s.id !== id);
  saveSnippets(snippets);
  updateTrayMenu();
  broadcast();
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
  // Bundle shape, so a round-trip keeps the folder structure. The importer above
  // still reads a bare array, which is what every earlier export produced.
  if (filePath) fs.writeFileSync(filePath, JSON.stringify({ version: 1, snippets, folders }, null, 2));
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
    // Accepts both shapes: a bare array (every export before folders existed)
    // and a {snippets, folders} bundle.
    const incomingSnippets = Array.isArray(imported) ? imported : imported.snippets;
    const incomingFolders = Array.isArray(imported) ? [] : (imported.folders || []);
    if (!Array.isArray(incomingSnippets)) return false;

    // Bring folders over first, so imported folderIds still resolve. A folder
    // whose id is taken is matched by name instead of duplicated.
    const folderIdMap = new Map();
    for (const f of incomingFolders) {
      const sameId = folders.find(x => x.id === String(f.id));
      const sameName = folders.find(x => x.name === f.name);
      if (sameId) { folderIdMap.set(String(f.id), sameId.id); continue; }
      if (sameName) { folderIdMap.set(String(f.id), sameName.id); continue; }
      const created = {
        id: String(f.id),
        name: f.name || 'Folder',
        order: folders.length,
        collapsed: !!f.collapsed,
        color: f.color || null,
        createdAt: f.createdAt || new Date().toISOString(),
      };
      folders.push(created);
      folderIdMap.set(String(f.id), created.id);
    }

    const existingIds = new Set(snippets.map(s => s.id));
    const newOnes = incomingSnippets
      .filter(s => !existingIds.has(s.id))
      .map(s => ({ ...s, folderId: folderIdMap.get(String(s.folderId)) ?? (s.folderId ?? null) }));

    snippets = [...snippets, ...newOnes];
    reconcile({ persist: false });
    saveSnippets(snippets);
    saveFolders(folders);
    updateTrayMenu();
    broadcast();
    return newOnes.length;
  } catch { return false; }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  app.dock.hide(); // Menu bar app — no dock icon

  createTray();
  startKeyboardHook();

  // Global shortcut — open manager and jump to search
  globalShortcut.register(prefs.hotkey || 'CmdOrCtrl+Shift+Space', () => createManagerWindow(true));

  // Open manager on first launch if no snippets — and always in dev, so the
  // window is reachable without clicking the tray icon.
  if (snippets.length === 0 || isDev) {
    setTimeout(createManagerWindow, 500);
  }

  if (isDev) {
    try {
      require('../../dev/harness').install({ app, getWindow: () => managerWindow });
    } catch (e) { console.error('[harness] failed to load:', e && e.stack || e); }
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when all windows are closed — stay in menu bar
  e.preventDefault();
});

app.on('will-quit', () => {
  // Guard: quitting before whenReady (a crash or an early kill) makes
  // globalShortcut throw, which surfaces as an ugly uncaught-exception dialog.
  if (app.isReady()) {
    try { globalShortcut.unregisterAll(); } catch {}
  }
  if (uiohook) {
    try { uiohook.stop(); } catch {}
  }
});
