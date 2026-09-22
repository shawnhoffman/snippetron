#!/usr/bin/env node
// Test runner. `npm test`, or `npm test -- links` to run one suite.
//
// Two kinds of suite:
//   *.test.js            plain Node — main-process logic and pure helpers
//   renderer/*.js        evaluated inside the real manager window, driven by
//                        dev/harness.js and run headless, so nothing appears
//                        on screen
//
// Every suite gets a throwaway data directory seeded from dev/tests/fixtures,
// so nothing here reads or writes ~/.snippetron.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDataDir, cleanup } = require('./lib/fixture');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');
const filter = process.argv.slice(2).filter(a => !a.startsWith('-'));
const wanted = (name) => filter.length === 0 || filter.some(f => name.includes(f));

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
const failures = [];

function record(suite, name, ok) {
  if (ok) { passed++; console.log(`  ${green('✓')} ${dim(name)}`); }
  else { failures.push(`${suite} › ${name}`); console.log(`  ${red('✗')} ${name}`); }
}

// ── plain Node suites ────────────────────────────────────────────────────────
async function runNodeSuite(file) {
  const suite = path.basename(file, '.test.js');
  console.log(`\n${suite}`);
  const t = { ok: (name, cond) => record(suite, name, !!cond) };
  try {
    await require(path.join(__dirname, file))(t);
  } catch (err) {
    record(suite, `suite threw: ${err && err.message}`, false);
  }
}

// ── renderer suites ──────────────────────────────────────────────────────────
function runRendererSuite(file) {
  const suite = path.basename(file, '.js');
  console.log(`\n${suite} ${dim('(renderer, headless)')}`);
  return new Promise((resolve) => {
    const dataDir = makeDataDir(suite);
    const resultFile = path.join(os.tmpdir(), `snippetron-result-${suite}-${Date.now()}.json`);
    const child = spawn(ELECTRON, [ROOT, '--dev'], {
      env: {
        ...process.env,
        SNIPPETRON_DATA_DIR: dataDir,
        SNIPPETRON_NO_HOOK: '1',
        SNIPPETRON_HEADLESS: '1',
        SNIPPETRON_EXIT: '1',
        SNIPPETRON_SCRIPT: path.join(__dirname, 'renderer', file),
        SNIPPETRON_RESULT: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d.toString(); });

    // A hung renderer must not hang the whole run.
    const killer = setTimeout(() => child.kill('SIGKILL'), 120000);

    child.on('close', () => {
      clearTimeout(killer);
      let result = null;
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}
      fs.rmSync(resultFile, { force: true });
      cleanup(dataDir);

      if (!result) {
        record(suite, 'suite produced no result', false);
        const noise = stderr.split('\n').filter(l =>
          l && !/trust_store_mac|Failed parsing|cert_verify|ssl_client|AiaRequest|CertVerify|Certificate|notAfter|handshake/.test(l));
        if (noise.length) console.log(dim('    ' + noise.slice(0, 5).join('\n    ')));
      } else if (result.__error) {
        record(suite, `suite threw: ${String(result.__error).split('\n')[0]}`, false);
      } else {
        for (const [name, ok] of Object.entries(result.checks || {})) record(suite, name, ok);
      }
      resolve();
    });
  });
}

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error('electron not installed — run npm install first');
    process.exit(1);
  }

  const nodeSuites = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).filter(wanted);
  const rendererSuites = fs.readdirSync(path.join(__dirname, 'renderer')).filter(f => f.endsWith('.js')).filter(wanted);

  for (const f of nodeSuites) await runNodeSuite(f);
  for (const f of rendererSuites) await runRendererSuite(f);

  console.log('');
  if (failures.length) {
    console.log(red(`${failures.length} failed`) + `, ${passed} passed`);
    failures.forEach(f => console.log(red('  ✗ ') + f));
    process.exit(1);
  }
  console.log(green(`${passed} passed`));
})();
