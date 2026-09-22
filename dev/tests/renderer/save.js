// Saving: the folder defaults to Unorganized, and no failure is silent.
const { ipcRenderer } = require('electron');
const checks = {};
const toasts = [];
const realToast = window.toast;
window.toast = (m, t) => { toasts.push((t || 'plain') + ':' + m); return realToast(m, t); };

const F = await ipcRenderer.invoke('create-folder', 'Quotes');
folders = await ipcRenderer.invoke('get-folders');
renderList(); await __wait(200);

async function newSnip(name, shortcut, html, folderId) {
  cancelEdit(); await __wait(120);
  newSnippet(folderId); await __wait(200);
  document.getElementById('field-name').value = name;
  document.getElementById('field-shortcut').value = shortcut;
  document.getElementById('editor').innerHTML = html;
}
const find = async (sc) => (await ipcRenderer.invoke('get-snippets')).find(s => s.shortcut === sc);

// ── the picker defaults to Unorganized and saving just works ──
await newSnip('No folder', 'nofolder', '<div>x</div>');
checks['the picker defaults to Unorganized'] = document.getElementById('field-folder').value === '';
toasts.length = 0;
await saveSnippet(); await __wait(350);
const nf = await find('nofolder');
checks['saving without choosing a folder succeeds'] = !!nf;
checks['it lands in Unorganized'] = nf && nf.folderId === null;
checks['the save is confirmed with a toast'] = toasts.some(t => t.startsWith('success:'));

// ── creating inside a folder still honours that folder ──
await newSnip('In folder', 'infolder', '<div>y</div>', F.id);
checks['the picker shows the inherited folder'] = document.getElementById('field-folder').value === F.id;
await saveSnippet(); await __wait(350);
checks['it saves into that folder'] = (await find('infolder')).folderId === F.id;

// ── a picker pointing at a deleted folder falls back rather than failing ──
selectSnippet((await find('nofolder')).id); await __wait(250);
document.getElementById('field-folder').value = F.id;
await ipcRenderer.invoke('delete-folder', F.id);
folders = await ipcRenderer.invoke('get-folders');
toasts.length = 0;
await saveSnippet(); await __wait(350);
checks['a stale folder falls back to Unorganized'] = (await find('nofolder')).folderId === null;
checks['the stale case still saves'] = toasts.some(t => t.startsWith('success:'));

// ── Enter in the header fields saves ──
await newSnip('Enter saves', 'entersave', '<div>z</div>');
document.getElementById('field-name').dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await __wait(450);
checks['Enter in the name field saves'] = !!(await find('entersave'));

// ── missing fields still warn ──
await newSnip('', '', '<div>q</div>');
toasts.length = 0;
await saveSnippet(); await __wait(200);
checks['a missing name warns'] = toasts.some(t => t.startsWith('error:'));

// ── a failing save must say so ──
await newSnip('Boom', 'boomtest', '<div>b</div>');
const realInvoke = ipcRenderer.invoke.bind(ipcRenderer);
ipcRenderer.invoke = (ch, ...a) =>
  ch === 'save-snippet' ? Promise.reject(new Error('simulated failure')) : realInvoke(ch, ...a);
toasts.length = 0;
await saveSnippet(); await __wait(300);
ipcRenderer.invoke = realInvoke;
checks['a failing save reports the reason'] = toasts.some(t => t.startsWith('error:Could not save'));

// ── emoji normalisation through the real save path ──
const NOTO = '<div><img src="https://fonts.gstatic.com/s/e/notoemoji/17.0/1f1f2_1f1fd/72.png"> hola</div>';
await newSnip('Emoji', 'emojitest', NOTO);
await saveSnippet(); await __wait(350);
const em = await find('emojitest');
checks['a saved emoji image becomes a character'] = em.html.includes('🇲🇽') && !em.html.includes('<img');

await newSnip('Real image', 'realimg', '<div><img src="https://example.com/logo.png" alt="Company logo"></div>');
await saveSnippet(); await __wait(350);
const ri = await find('realimg');
checks['a real image survives the save'] = ri.html.includes('<img') && ri.html.includes('logo.png');

// an unrecognised emoji image is at least capped visually
document.getElementById('editor').innerHTML = NOTO.replace('/notoemoji/17.0/1f1f2_1f1fd/72.png', '/emoji/weird.png');
await __wait(150);
const img = document.querySelector('#editor img');
checks['an unrecognised emoji image is capped'] = !img || img.getBoundingClientRect().height < 30;

return { checks };
