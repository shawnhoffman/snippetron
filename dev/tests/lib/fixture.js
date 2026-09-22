// A throwaway data directory seeded from the synthetic fixture. Tests never read
// or write ~/.snippetron, so they are deterministic and can't touch real data.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');

function makeDataDir(label = 'run') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `snippetron-test-${label}-`));
  fs.copyFileSync(path.join(FIXTURES, 'snippets.json'), path.join(dir, 'snippets.json'));
  fs.copyFileSync(path.join(FIXTURES, 'prefs.json'), path.join(dir, 'prefs.json'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = { makeDataDir, cleanup, FIXTURES };
