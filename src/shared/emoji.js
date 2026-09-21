// Emoji normalisation, shared by the renderer (on paste / on load) and the main
// process (on copy / expand), so what you see and what you paste agree.
//
// Pasting an emoji from Gmail or Google Docs brings an <img> rather than a
// character — typically a Noto PNG at its natural 72px, e.g.
//   <img src="https://fonts.gstatic.com/s/e/notoemoji/17.0/1f1f2_1f1fd/72.png">
// Next to 14px text that renders enormous, and it pastes into an email just as
// large. Converting it back to the actual character makes it scale with the
// surrounding font, survive offline, and drop the external image request.

// Noto emoji CDN paths encode the codepoints: .../notoemoji/<ver>/<cps>/<size>.png
// where <cps> is underscore-separated hex (1f1f2_1f1fd = 🇲🇽).
const NOTO_IMG = /<img\b[^>]*\bsrc\s*=\s*(["'])([^"']*\/notoemoji\/[^"']*?\/([0-9a-fA-F]{4,6}(?:_[0-9a-fA-F]{4,6})*)\/[^"']*)\1[^>]*>/gi;

// Gmail and others ship the character itself in alt=; trust it only when the
// alt is nothing but emoji, so real images keep their alt text and their tag.
const ALT_IMG = /<img\b[^>]*\balt\s*=\s*(["'])([^"']{1,16})\1[^>]*>/gi;
const ONLY_EMOJI = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}‍️])+$/u;

function codepointsToChars(cps) {
  try {
    return String.fromCodePoint(...cps.split('_').map(h => parseInt(h, 16)));
  } catch {
    return null;
  }
}

// Replace emoji <img> tags with the characters they depict. Anything that isn't
// recognisably an emoji image is left exactly as it was.
function normalizeEmojiHtml(html) {
  if (typeof html !== 'string' || html.indexOf('<img') === -1) return html;

  let out = html.replace(NOTO_IMG, (tag, _q, _src, cps) => codepointsToChars(cps) || tag);
  out = out.replace(ALT_IMG, (tag, _q, alt) => (ONLY_EMOJI.test(alt) ? alt : tag));
  return out;
}

module.exports = { normalizeEmojiHtml };
