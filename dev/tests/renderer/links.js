// Runs inside the manager renderer. Returns { checks: { name: boolean } }.
const checks = {};
const editor = document.getElementById('editor');
const textIn = () => document.getElementById('link-text-input');
const urlIn  = () => document.getElementById('link-url-input');
const dlg    = () => document.getElementById('link-dialog');
const isOpen = () => dlg().style.display === 'block';
const key = (el, k, o = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
function caret(el, off) {
  const r = document.createRange();
  r.setStart(el.firstChild || el, off); r.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

selectSnippet(snippets[0].id);
await __wait(300);

// Cmd+K opens the dialog
editor.innerHTML = '<div>Hello world</div>';
editor.focus();
caret(editor.querySelector('div'), 5);
key(editor, 'k', { metaKey: true });
await __wait(150);
checks['cmd+K opens the link dialog'] = isOpen();
cancelLinkDialog(); await __wait(100);

// creating from a selection prefills the text, Enter applies
editor.innerHTML = '<div>Click here now</div>';
const div = editor.querySelector('div');
const r = document.createRange();
r.setStart(div.firstChild, 6); r.setEnd(div.firstChild, 10);
const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
showLinkDialog(); await __wait(150);
checks['selected text prefills the Text field'] = textIn().value === 'here';
urlIn().value = 'example.com';
key(dlg(), 'Enter'); await __wait(200);
checks['Enter applies and closes'] = !isOpen();
checks['a bare domain gets https://'] = /<a href="https:\/\/example\.com">here<\/a>/.test(editor.innerHTML);
checks['Enter does not insert a newline'] = editor.textContent === 'Click here now';

// the original bug: editing with a collapsed caret inside the link
editor.innerHTML = '<div><a href="https://old.com/">Original Link</a></div>';
caret(editor.querySelector('a'), 9);
showLinkDialog(); await __wait(150);
checks['editing prefills text and url'] =
  textIn().value === 'Original Link' && urlIn().value === 'https://old.com/';
urlIn().value = 'https://myNEWlink.com/';
applyLink(); await __wait(200);
checks['the url is replaced'] = /href="https:\/\/myNEWlink\.com\/"/.test(editor.innerHTML);
checks['the label is left alone'] = editor.textContent === 'Original Link';
checks['the url is not injected into the text'] = !editor.textContent.includes('myNEWlink');
checks['exactly one anchor remains'] = editor.querySelectorAll('a').length === 1;

// text and url together
editor.innerHTML = '<div><a href="https://old.com/">Old Label</a></div>';
caret(editor.querySelector('a'), 3);
showLinkDialog(); await __wait(150);
textIn().value = 'Brand New Label';
urlIn().value = 'newsite.org/path';
applyLink(); await __wait(200);
checks['text and url can both be changed'] =
  /<a href="https:\/\/newsite\.org\/path">Brand New Label<\/a>/.test(editor.innerHTML);

// surrounding content survives, with no &nbsp; damage
editor.innerHTML = '<div>before <a href="https://old.com/">mid</a> after</div>';
caret(editor.querySelector('a'), 1);
showLinkDialog(); await __wait(120);
urlIn().value = 'https://new.com/';
applyLink(); await __wait(200);
checks['surrounding text and spacing survive'] =
  editor.textContent === 'before mid after' && /href="https:\/\/new\.com\/"/.test(editor.innerHTML);

// typing after a new link stays outside it
editor.innerHTML = '<div>x</div>';
caret(editor.querySelector('div'), 1);
showLinkDialog(); await __wait(120);
textIn().value = 'site'; urlIn().value = 'a.com';
applyLink(); await __wait(200);
document.execCommand('insertText', false, 'TAIL');
await __wait(120);
checks['typing after a link is not linked'] = /<a href="https:\/\/a\.com">site<\/a>TAIL/.test(editor.innerHTML);

// remove keeps the label
editor.innerHTML = '<div>keep <a href="https://x.com/">this label</a> please</div>';
caret(editor.querySelector('a'), 2);
showLinkDialog(); await __wait(120);
removeLink(); await __wait(200);
checks['remove link keeps the label text'] =
  editor.querySelectorAll('a').length === 0 && editor.textContent === 'keep this label please';

// escape discards
editor.innerHTML = '<div><a href="https://keep.com/">Keep</a></div>';
const before = editor.innerHTML;
caret(editor.querySelector('a'), 2);
showLinkDialog(); await __wait(120);
urlIn().value = 'https://discard.com/';
key(dlg(), 'Escape'); await __wait(200);
checks['Escape cancels without changing anything'] = !isOpen() && editor.innerHTML === before;

// email addresses
editor.innerHTML = '<div>mail</div>';
const r2 = document.createRange();
r2.selectNodeContents(editor.querySelector('div'));
sel.removeAllRanges(); sel.addRange(r2);
showLinkDialog(); await __wait(120);
urlIn().value = 'shawn@teaching.com';
applyLink(); await __wait(180);
checks['an email address becomes mailto:'] = /href="mailto:shawn@teaching\.com"/.test(editor.innerHTML);

// an empty url is a no-op
editor.innerHTML = '<div>plain</div>';
const before2 = editor.innerHTML;
caret(editor.querySelector('div'), 2);
showLinkDialog(); await __wait(120);
urlIn().value = '   ';
applyLink(); await __wait(180);
checks['an empty url changes nothing'] = editor.innerHTML === before2 && !isOpen();

return { checks };
