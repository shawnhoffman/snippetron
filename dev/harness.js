// Dev-only automation harness. Loaded from main.js only when --dev is passed.
//
// Environment variables:
//   SNIPPETRON_DATA_DIR  isolate data files (read in main.js, not here)
//   SNIPPETRON_NO_HOOK   skip the global keyboard hook, so a dev instance can't
//                        double-fire expansions alongside the installed app
//   SNIPPETRON_SHOT      directory to write capturePage() PNGs into
//   SNIPPETRON_SCRIPT    path to a JS file evaluated in the manager renderer
//   SNIPPETRON_EXIT      quit after the script + captures finish
//
// Each SNIPPETRON_SCRIPT file exports a sequence by simply being an async IIFE
// whose resolved value is logged. Between steps it may call
// __shot('name') to trigger a capture from inside the renderer.
const fs = require('fs');
const path = require('path');

function install({ app, getWindow }) {
  const shotDir = process.env.SNIPPETRON_SHOT;
  const scriptPath = process.env.SNIPPETRON_SCRIPT;
  if (!shotDir && !scriptPath) return;

  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

  async function capture(win, name) {
    const img = await win.capturePage();
    const file = path.join(shotDir || '.', `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log(`[harness] shot ${file}`);
  }

  async function run() {
    const win = getWindow();
    if (!win) { console.log('[harness] no manager window'); return; }
    await new Promise(r => setTimeout(r, 900)); // let fonts + first paint settle

    // Expose a capture hook the renderer script can await.
    const { ipcMain } = require('electron');
    ipcMain.handle('__shot', async (_, name) => { await capture(win, name); return true; });

    if (scriptPath) {
      const src = fs.readFileSync(scriptPath, 'utf8');
      try {
        const result = await win.webContents.executeJavaScript(
          `(async () => {\n` +
          `  const __shot = async (n) => require('electron').ipcRenderer.invoke('__shot', n);\n` +
          `  const __wait = (ms) => new Promise(r => setTimeout(r, ms));\n` +
          `  try { ${src}\n } catch (e) { return { __error: String(e && e.stack || e) }; }\n` +
          `})()`,
          true
        );
        console.log('[harness] result ' + JSON.stringify(result, null, 2));
      } catch (e) {
        console.log('[harness] script threw ' + (e && e.stack || e));
      }
    } else {
      await capture(win, 'default');
    }

    if (process.env.SNIPPETRON_EXIT) {
      console.log('[harness] done, exiting');
      setTimeout(() => app.exit(0), 300);
    }
  }

  // Wait for the manager window, then run once. Give up rather than hang forever —
  // a hung run gets killed, and a killed Electron makes macOS show its
  // "reopen windows?" prompt on the next launch, which blocks startup.
  let waited = 0;
  const iv = setInterval(() => {
    if (getWindow()) { clearInterval(iv); run(); return; }
    waited += 250;
    if (waited > 15000) {
      clearInterval(iv);
      console.log('[harness] timed out waiting for the manager window');
      app.exit(1);
    }
  }, 250);
}

module.exports = { install };
