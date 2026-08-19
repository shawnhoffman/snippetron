// Loads src/main/main.js in plain Node with a stubbed `electron` module, so the
// main-process data logic (migration, folders, apply-layout) can be exercised
// without launching a window. Returns the recorded IPC handlers.
const Module = require('module');
const path = require('path');

function makeStub() {
  const handlers = new Map();
  const sent = [];
  const noop = () => {};
  const win = () => ({
    isDestroyed: () => false,
    webContents: { send: (ch, payload) => sent.push({ ch, payload }), on: noop, executeJavaScript: noop },
    on: noop, once: noop, show: noop, focus: noop, close: noop, loadFile: noop, capturePage: noop,
  });
  const electron = {
    app: {
      whenReady: () => new Promise(() => {}),   // never resolves: skip window/tray setup
      on: noop, isReady: () => false, dock: { hide: noop }, hide: noop, quit: noop, exit: noop,
      getVersion: () => '0.0.0-test', relaunch: noop, setLoginItemSettings: noop,
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
    BrowserWindow: function () { return win(); },
    Tray: function () { return { setContextMenu: noop, setToolTip: noop, setImage: noop, on: noop }; },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: noop },
    clipboard: { writeText: noop, readText: () => '', write: noop, readHTML: () => '' },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: noop, removeHandler: (ch) => handlers.delete(ch) },
    nativeImage: { createFromPath: () => ({ setTemplateImage: noop, isEmpty: () => true }), createEmpty: () => ({ setTemplateImage: noop }) },
    globalShortcut: { register: () => true, unregisterAll: noop, isRegistered: () => false },
    dialog: { showSaveDialog: async () => ({}), showOpenDialog: async () => ({ filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openExternal: noop },
    Notification: function () { return { show: noop }; },
  };
  electron.BrowserWindow.getAllWindows = () => [];
  return { electron, handlers, sent };
}

function load(dataDir) {
  const { electron, handlers, sent } = makeStub();
  process.env.SNIPPETRON_DATA_DIR = dataDir;
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'uiohook-napi') throw new Error('stubbed out');
    if (request === 'electron-updater') throw new Error('stubbed out');
    return orig.apply(this, arguments);
  };
  try {
    const p = path.join(__dirname, '..', 'src', 'main', 'main.js');
    delete require.cache[require.resolve(p)];
    require(p);
  } finally {
    Module._load = orig;
  }
  const invoke = (ch, ...args) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error('no handler for ' + ch);
    return fn({}, ...args);
  };
  return { invoke, handlers, sent };
}

module.exports = { load };
