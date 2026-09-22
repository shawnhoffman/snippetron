// Folder rendering, search reveal, sorting, keyboard nav, drag and drop.
const { ipcRenderer } = require('electron');
const checks = {};
const listEl = document.getElementById('snippet-list');
const si = document.getElementById('search-input');
const search = async (v) => { si.value = v; si.dispatchEvent(new Event('input', { bubbles: true })); await __wait(200); };
const snipRow = (id) => document.querySelector(`.snippet-item[data-id="${id}"]`);

// ── flat baseline: with no folders it looks exactly like the old list ──
checks['no folders means no section header'] = document.querySelectorAll('.section-row').length === 0;
const flatCount = document.querySelectorAll('.snippet-item').length;
checks['every snippet is listed'] = flatCount === snippets.length;
checks['filtered matches what is on screen'] = filtered.length === flatCount;

// ── build folders ──
const A = await ipcRenderer.invoke('create-folder', 'Alpha');
const B = await ipcRenderer.invoke('create-folder', 'Beta');
const C = await ipcRenderer.invoke('create-folder', 'Empty');
folders = await ipcRenderer.invoke('get-folders');
const all = await ipcRenderer.invoke('get-snippets');
await ipcRenderer.invoke('apply-layout', { folders: [], snippets: [
  ...all.slice(0, 2).map((s, i) => ({ id: s.id, folderId: A.id, order: i })),
  ...all.slice(2, 3).map((s, i) => ({ id: s.id, folderId: B.id, order: i })),
]});
snippets = await ipcRenderer.invoke('get-snippets');
renderList(); await __wait(200);

checks['folder rows render'] = document.querySelectorAll('.folder-row').length === 3;
checks['the Unorganized section appears'] = document.querySelectorAll('.section-row').length === 1;
checks['an empty folder shows a placeholder'] = document.querySelectorAll('.folder-empty').length === 1;
checks['children are indented'] = getComputedStyle(document.querySelector('.folder-children')).marginLeft === '14px';
const folderBg = getComputedStyle(document.querySelector('.folder-row')).backgroundColor;
const snipBg = getComputedStyle(document.querySelector('.snippet-item')).backgroundColor;
checks['folder rows are a lighter shade'] = folderBg !== snipBg;

// ── collapse / expand ──
document.querySelector('.folder-row').click(); await __wait(200);
checks['clicking a folder collapses it'] = document.querySelector('.folder-children').hidden;
checks['collapsed children leave keyboard nav'] =
  filtered.length === [...listEl.querySelectorAll('.snippet-item')].filter(e => !e.closest('[hidden]')).length;

const collapsedBefore = folders.map(f => f.collapsed);
await search(all[0].shortcut.slice(0, 4));
checks['search reveals matches inside a collapsed folder'] = !document.querySelector('.folder-children')?.hidden;
checks['folders with no match are hidden'] = document.querySelectorAll('.folder-row').length < 3;
await search('');
checks['collapse state survives a search'] = JSON.stringify(folders.map(f => f.collapsed)) === JSON.stringify(collapsedBefore);
checks['the folder recollapses after clearing'] = document.querySelector('.folder-children').hidden;

document.getElementById('expand-all-btn').click(); await __wait(200);
checks['expand all opens everything'] = [...document.querySelectorAll('.folder-children')].every(e => !e.hidden);
document.getElementById('expand-all-btn').click(); await __wait(200);
checks['collapse all closes everything'] = [...document.querySelectorAll('.folder-children')].every(e => e.hidden);
document.getElementById('expand-all-btn').click(); await __wait(200);

// ── inline rename ──
const fr = document.querySelector('.folder-row');
fr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
await __wait(150);
const input = document.querySelector('.folder-name-input');
checks['double-click opens a rename input'] = !!input;
if (input) {
  input.value = 'Renamed';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await __wait(300);
}
checks['rename commits on Enter'] = !!(await ipcRenderer.invoke('get-folders')).find(f => f.name === 'Renamed');

// ── sorting is view-only ──
const manualOrder = [...document.querySelectorAll('.snippet-item')].map(e => e.dataset.id);
const storedBefore = (await ipcRenderer.invoke('get-snippets')).map(s => s.id + ':' + s.order).join();
document.getElementById('sort-btn').click(); await __wait(120);
document.querySelector('#sort-popup .popup-item[data-key="snippetSort"][data-val="name"]').click();
await __wait(250);
checks['sorting changes the view'] =
  JSON.stringify([...document.querySelectorAll('.snippet-item')].map(e => e.dataset.id)) !== JSON.stringify(manualOrder);
checks['drag is disabled while sorted'] = document.querySelector('.snippet-item').getAttribute('draggable') === 'false';
document.getElementById('sort-btn').click(); await __wait(120);
document.querySelector('#sort-popup .popup-item[data-key="snippetSort"][data-val="manual"]').click();
await __wait(250);
checks['manual order comes back'] =
  JSON.stringify([...document.querySelectorAll('.snippet-item')].map(e => e.dataset.id)) === JSON.stringify(manualOrder);
checks['sorting never rewrote the stored order'] =
  (await ipcRenderer.invoke('get-snippets')).map(s => s.id + ':' + s.order).join() === storedBefore;

// ── drag and drop ──
function drag(src, tgt, fracY) {
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const rect = tgt.getBoundingClientRect();
  tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height * fracY }));
  const captured = dropTarget ? JSON.parse(JSON.stringify(dropTarget)) : null;
  tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return captured;
}
const idsIn = async (fid) => (await ipcRenderer.invoke('get-snippets'))
  .filter(s => (s.folderId ?? null) === fid).sort((a, b) => a.order - b.order).map(s => s.id);

const loose = (await idsIn(null))[0];
drag(snipRow(loose), document.querySelector(`.folder-row[data-id="${B.id}"]`), 0.5);
await __wait(300);
checks['dragging a snippet into a folder works'] = (await idsIn(B.id)).includes(loose);

const inB = await idsIn(B.id);
drag(snipRow(inB[inB.length - 1]), document.querySelector('.section-row'), 0.5);
await __wait(300);
checks['dragging out to Unorganized works'] =
  (await ipcRenderer.invoke('get-snippets')).find(s => s.id === inB[inB.length - 1]).folderId === null;

const folderIds = [...document.querySelectorAll('.folder-row')].map(e => e.dataset.id);
const tgt = drag(document.querySelector(`.folder-row[data-id="${folderIds[0]}"]`),
                 document.querySelector(`.folder-row[data-id="${folderIds[1]}"]`), 0.5);
checks['folders cannot nest'] = !tgt || tgt.type === 'folder-at';

// a render arriving mid-drag must be deferred, not applied
const anyRow = snipRow((await idsIn(null))[0]);
const dt2 = new DataTransfer();
anyRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt2 }));
const domBefore = listEl.innerHTML.length;
renderList();
checks['a render during a drag is deferred'] = renderPending === true && listEl.innerHTML.length === domBefore;
document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt2 }));
await __wait(200);
checks['the deferred render flushes on dragend'] = renderPending === false;

// drag is off while filtering
await search('quote');
const dt3 = new DataTransfer();
document.querySelector('.snippet-item').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt3 }));
checks['drag is refused while searching'] = dragState.active === false;
document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt3 }));
await search('');

return { checks };
