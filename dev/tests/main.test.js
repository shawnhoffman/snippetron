// Main-process tests. These load src/main/main.js in plain Node with a stubbed
// `electron` module (dev/mainstub.js), so they run in about a second and never
// open a window.
const fs = require('fs');
const path = require('path');
const { makeDataDir, cleanup } = require('./lib/fixture');

module.exports = async function run(t) {
  const dir = makeDataDir('main');
  const { invoke } = require('../mainstub').load(dir);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'snippets.json'), 'utf8'));

  // ── migration ──
  let snips = await invoke('get-snippets');
  t.ok('migration adds folderId and order', snips.every(s => s.folderId === null && Number.isFinite(s.order)));
  t.ok('order is dense 0..n-1', snips.map(s => s.order).sort((a, b) => a - b).every((v, i) => v === i));
  t.ok('migration keeps the original order', snips.sort((a, b) => a.order - b.order).map(s => s.shortcut).join() === 'quote3,quote1,po,welcome,sig');
  t.ok('a pre-folders backup is written', fs.existsSync(path.join(dir, 'snippets.json.bak-preFolders')));
  t.ok('snippets.json stays a bare array', Array.isArray(read()));

  // ── folder CRUD ──
  const A = await invoke('create-folder', '  Quotes  ');
  const B = await invoke('create-folder', 'Onboarding');
  t.ok('folder name is trimmed', A.name === 'Quotes');
  t.ok('rename works', (await invoke('rename-folder', B.id, 'Onboarding steps')) === true);
  t.ok('an empty rename is rejected', (await invoke('rename-folder', B.id, '   ')) === false);
  t.ok('renaming an unknown folder is rejected', (await invoke('rename-folder', 'nope', 'x')) === false);

  // ── apply-layout ──
  await invoke('apply-layout', { snippets: snips.slice(0, 2).map((s, i) => ({ id: s.id, folderId: A.id, order: i })) });
  snips = await invoke('get-snippets');
  t.ok('snippets move into a folder', snips.filter(s => s.folderId === A.id).length === 2);
  t.ok('the source container reindexes', snips.filter(s => s.folderId === null).map(s => s.order).sort((a, b) => a - b).every((v, i) => v === i));

  const victim = snips.find(s => s.folderId === null);
  await invoke('apply-layout', { snippets: [{ id: victim.id, folderId: 'bogus', order: 0 }, { id: 'ghost', folderId: A.id, order: 0 }] });
  snips = await invoke('get-snippets');
  t.ok('an unknown folderId is refused', snips.find(s => s.id === victim.id).folderId === null);
  t.ok('an unknown snippet id is ignored', snips.length === 5);

  // ── save-snippet merges rather than replacing ──
  const withUse = snips.find(s => (s.useCount || 0) > 0);
  await invoke('save-snippet', { id: withUse.id, name: 'renamed', createdAt: undefined });
  snips = await invoke('get-snippets');
  const merged = snips.find(s => s.id === withUse.id);
  t.ok('saving keeps useCount', merged.useCount === withUse.useCount);
  t.ok('saving keeps folderId', merged.folderId === withUse.folderId);
  t.ok('an undefined field does not blank the stored value', !!merged.createdAt);

  await invoke('save-snippet', { id: 'fresh', name: 'N', shortcut: 'zzz', subject: '', html: '<p>x</p>', createdAt: new Date().toISOString() });
  snips = await invoke('get-snippets');
  const fresh = snips.find(s => s.id === 'fresh');
  t.ok('a new snippet lands in Unorganized with an order', fresh.folderId === null && Number.isFinite(fresh.order));

  // ── deleting a folder orphans its children ──
  const before = snips.length;
  await invoke('delete-folder', A.id);
  snips = await invoke('get-snippets');
  t.ok('deleting a folder keeps its snippets', snips.length === before);
  t.ok('orphans move to Unorganized', snips.every(s => s.folderId !== A.id));

  // ── collapse persists ──
  await invoke('set-folder-collapsed', B.id, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'folders.json'), 'utf8'));
  t.ok('collapse is written to folders.json', onDisk.folders.find(f => f.id === B.id).collapsed === true);
  t.ok('folders.json has the expected shape', onDisk.version === 1 && Array.isArray(onDisk.folders));

  const prefs = await invoke('get-prefs');
  t.ok('sort and width defaults exist', prefs.snippetSort === 'manual' && prefs.folderSort === 'manual' && prefs.sidebarWidth === 240);

  cleanup(dir);
};
