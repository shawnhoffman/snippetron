# Snippetron 🔮
### Rich text snippet expander for macOS

Expand typed shortcuts into fully-formatted rich text — works in Front.com, web apps, and native desktop apps.

---

## Setup

### Prerequisites
- **Node.js** (v18 or higher) — download from [nodejs.org](https://nodejs.org)
- **macOS** 11 or later

### Install & Run

```bash
cd snippetron
npm install
npm start
```

### First-time: Grant Accessibility Permission

On first launch, macOS will ask for **Accessibility** permission so Snippetron can detect your typing and simulate paste.

1. macOS will show a prompt — click **Open System Settings**
2. Go to **Privacy & Security → Accessibility**
3. Enable **Snippetron** (or **Electron** during development)
4. Restart the app

> This is required for all cross-app text expanders (TextExpander, Espanso, Raycast, etc. all need the same permission).

---

## Usage

### Expanding snippets
Type your trigger prefix (default `::`) followed by your shortcut, anywhere:
```
::followup     →  expands your "Sales Follow-Up" snippet
::sig          →  expands your email signature
::addr         →  expands your address block
```

### Search & browse (no trigger needed)
Press **⌘⇧Space** from any app to open the search palette. Type to filter, press ↵ to paste.

Or click the **Snippetron** icon in your menu bar → **Search Snippets…**

### Merge fields
Add `{fieldname}` anywhere in your snippet content. When you expand it, a small dialog will appear asking you to fill in each field before pasting.

Example: `Hi {name}, thanks for your interest in {product}...`

---

## Creating Snippets

1. Click the **Snippetron** menu bar icon → **Manage Snippets**
2. Click **+ New Snippet**
3. Fill in:
   - **Name** — human-readable label (e.g. "Sales Follow-Up")
   - **Shortcut** — the word you type after `::` (e.g. `followup`)
   - **Content** — use the WYSIWYG toolbar for bold, italic, links, lists
4. Press **⌘S** or click **Save**

---

## Rich Text Compatibility

| App | Format used | Works? |
|-----|-------------|--------|
| Front.com (web) | HTML | ✅ |
| Gmail | HTML | ✅ |
| Apple Mail | RTF | ✅ |
| Outlook (desktop) | RTF | ✅ |
| Notion | HTML | ✅ |
| Slack (desktop) | RTF/HTML | ✅ |
| Pages, Word | RTF | ✅ |
| Plain text apps | Plain text fallback | ✅ |

Snippetron writes **HTML, RTF, and plain text** to the clipboard simultaneously. Each app picks up whichever format it supports best.

---

## Preferences

Click **Manage Snippets** → **Preferences** tab:

- **Trigger prefix** — change from `::` to `;;`, `//`, or anything you like
- **Export snippets** — save all snippets as JSON
- **Import snippets** — load snippets from a JSON file (merges, no duplicates)

---

## Data & Portability

All snippets are stored at:
```
~/.snippetron/snippets.json
```

You can back this up, sync it via Dropbox/iCloud Drive, or share it with another machine. Just point both machines to the same file, or use **Export/Import**.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘⇧Space` | Open snippet search from any app |
| `⌘S` | Save snippet (in manager) |
| `↵` | Paste selected snippet (in search) |
| `↑↓` | Navigate results (in search) |
| `Esc` | Close search / cancel merge |

---

## Troubleshooting

**Snippets aren't expanding**
→ Check Accessibility permission (System Settings → Privacy & Security → Accessibility)
→ Make sure the app is running (check menu bar)

**Rich text isn't pasting correctly in a specific app**
→ Try pasting with **⌘⇧V** (Paste and Match Style) — if that works, the app is stripping HTML. This is an app limitation.
→ For Front.com specifically, make sure you're clicking into the compose area before triggering.

**The app shows "Electron" in Accessibility settings**
→ That's normal during development via `npm start`. A packaged `.app` would show "Snippetron".
