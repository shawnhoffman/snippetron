// Pure unit tests for the shared emoji normaliser — no Electron needed.
const { normalizeEmojiHtml } = require('../../src/shared/emoji');

module.exports = async function run(t) {
  const noto = '<img src="https://fonts.gstatic.com/s/e/notoemoji/17.0/1f1f2_1f1fd/72.png">';
  t.ok('a Noto emoji image becomes its character', normalizeEmojiHtml(noto) === '🇲🇽');

  t.ok(
    'an emoji image inline keeps its surroundings',
    normalizeEmojiHtml('<div>hi <img src="https://fonts.gstatic.com/s/e/notoemoji/15.0/1f600/72.png"> there</div>')
      === '<div>hi 😀 there</div>'
  );

  t.ok(
    'single quotes are handled',
    normalizeEmojiHtml("<img src='https://fonts.gstatic.com/s/e/notoemoji/15.0/1f389/72.png'>") === '🎉'
  );

  t.ok(
    'an emoji-only alt is used',
    normalizeEmojiHtml('<img alt="🎉" src="https://mail.google.com/x.png">') === '🎉'
  );

  const logo = '<img alt="Company logo" src="https://x.com/logo.png">';
  t.ok('a real image with alt text is untouched', normalizeEmojiHtml(logo) === logo);

  const shot = '<img src="https://x.com/screenshot.png">';
  t.ok('a plain image is untouched', normalizeEmojiHtml(shot) === shot);

  const plain = '<div>no images at all</div>';
  t.ok('html without images passes straight through', normalizeEmojiHtml(plain) === plain);

  t.ok('non-string input is returned as-is', normalizeEmojiHtml(undefined) === undefined);
  t.ok('an empty string is safe', normalizeEmojiHtml('') === '');
};
