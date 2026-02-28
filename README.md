# ThunderClerk-AI — Thunderbird Extension

Add emails to your Thunderbird calendar or task list with a single right-click, using a **local Ollama model** to extract the event or task details.

No cloud accounts, no API keys, no text selection required — just Thunderbird and a running [Ollama](https://ollama.com) instance.

---

## Features

- **Add to Calendar** — right-click any email and open a pre-filled New Event dialog
- **Add as Task** — right-click any email and open a pre-filled New Task dialog
- **Draft Reply** — generate a context-aware reply draft
- **Summarize & Forward** — produce a TL;DR + bullet-point summary for forwarding
- **Extract Contact** — pull contact info from email signatures into your address book
- **Catalog Email** — auto-tag emails using AI, with support for existing Thunderbird tags
- **Auto Analyze** — single-click analysis: get a summary, detected events/tasks/contacts ("What I Found") as clickable Add buttons, a suggested AI reply, and five always-visible Quick Actions (create event, create task, extract contact, summarize & forward, tag email). Cached results display instantly; on cache miss a single combined Ollama call runs (~30-60s) and caches the result. Archive/Delete checkboxes at the bottom for post-triage cleanup. Also available via keyboard shortcut (`Ctrl+Shift+E`). Disabled by default — requires a 20B+ parameter model (see settings).
- **Background Processing** — automatically processes incoming emails in the background using a single combined Ollama call. Results are cached persistently so Auto Analyze shows results instantly (no waiting for Ollama). New emails are processed as they arrive; existing emails are backfilled on startup. Manual actions always take priority over background processing.
- AI extracts title, dates, times, attendees, and (optionally) category
- Reads the full email body — no need to select text first
- All processing is done locally via your own Ollama instance
- Auto-tagging can run in the background after any other action
- Configurable: model, host, attendees source, default calendar, description format, categories

## Requirements

- Thunderbird 128 or later
- [Ollama](https://ollama.com) running locally (or on a reachable host)
- At least one model pulled, e.g. `ollama pull mistral:7b`

## Installation

### From ATN (addons.thunderbird.net)

Search for **ThunderClerk-AI** and click Install.

### From source

```
git clone https://github.com/coffeeOwl1/thunderclerk-ai
cd thunderbird-thunderclerk-ai
./build.sh prod
```

In Thunderbird: **Add-ons Manager → gear icon → Install Add-on From File** → select `thunderclerk-ai.xpi`.

## Configuration

After installation the Settings page opens automatically. You can also reach it via **Add-ons Manager → ThunderClerk-AI → Preferences**.

| Setting | Default | Description |
|---|---|---|
| Ollama Host URL | `http://127.0.0.1:11434` | Where Ollama is running |
| Model | `mistral:7b` | Which model to use (dropdown populated from Ollama) |
| Default Calendar | (currently selected) | Which calendar to create events in |
| Attendees | From + To | Which addresses to suggest to the AI |
| Event Description | Body + From + Subject | What to pre-fill in the event Description field (options: Body + From + Subject, Body only, AI-generated summary, None) |
| Task Description | Body + From + Subject | What to pre-fill in the task Description field (options: Body + From + Subject, Body only, AI-generated summary, None) |
| Default Due Date | None | Fallback when no deadline is found |
| Auto-select category | Off | Ask the AI to pick the best category for events/tasks |
| Auto-tag after actions | On | Automatically tag emails after using other actions |
| Allow new tags | Off | Let the AI create new tags (experimental — may clutter your tag list) |
| Context Window (tokens) | 0 (model default) | Override the model's context window size. Controls KV cache VRAM usage. |
| Max Output Tokens | 0 (model default) | Override the maximum generation length. Thinking/reasoning models need 8192+. |
| Enable Auto Analyze | Off | Show the Auto Analyze menu item and keyboard shortcut. Requires a 20B+ parameter model with at least 16 GB VRAM. Smaller models produce unreliable results. |
| Process emails in the background | Off | Automatically analyze incoming emails so Auto Analyze results are instant. Requires Auto Analyze to be enabled. |
| Cache duration | 1 day | How long to keep cached analysis results. Options: 1/3/7/14/30 days. |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+E` | Auto Analyze the displayed email |

You can customize the shortcut in **Add-ons Manager → gear icon → Manage Extension Shortcuts**.

## Permissions

The extension requests these permissions:

- **messagesRead** — read email content for AI analysis
- **messagesMove** — archive emails (via Auto Analyze)
- **messagesDelete** — delete emails (via Auto Analyze)
- **messageDisplay** — detect which message is open (for keyboard shortcut)
- **menus** — add right-click context menu items
- **storage** — save settings
- **compose** — create reply/forward drafts
- **addressBooks** — save extracted contacts
- **notifications** — show progress/error notifications
- **messagesTags / messagesTagsList / messagesUpdate** — catalog/tag emails
- **accountsRead** — listen for new mail (background processing), query messages across accounts

## Privacy

Email content is sent to the Ollama host you configure — by default your own machine. Nothing is sent to the extension developer or any third party. See [PRIVACY.md](PRIVACY.md) for details.

## License

GPL v3 — see [LICENSE](LICENSE).

The CalendarTools experiment API is adapted from [ThunderAI Sparks](https://micz.it/thunderbird-addon-thunderai/#sparks) by Mic (m@micz.it), Copyright (C) 2024-2025, GPL v3.

## Development

```bash
npm install        # install Jest for tests
npm test           # unit tests (~189 cases)
npm run test:integration  # integration tests (needs running Ollama)
```

To configure the Ollama host/model for integration tests, copy the example
config and edit it:

```bash
cp config.test.js.example config.test.js
# edit config.test.js with your Ollama host and model
```

Environment variables (`OLLAMA_HOST`, `OLLAMA_MODEL`) override the config file.

### Live development (no .xpi needed)

For fast iteration, load the extension directly from source instead of rebuilding the .xpi every time:

1. Run `./build.sh dev` once to copy your dev config into place
2. In Thunderbird: **Add-ons Manager → gear icon (⚙) → Debug Add-ons**
3. Click **Load Temporary Add-on** and select `manifest.json` from the project directory
4. After editing source files, click **Reload** next to the extension on the Debug Add-ons page

The temporary add-on persists until you close Thunderbird. If JavaScript
changes aren't reflected, restart Thunderbird with `thunderbird -purgecaches`.

### Building the .xpi

A build script handles config selection and packaging:

```bash
./build.sh dev    # uses config.dev.js (personal settings, gitignored)
./build.sh prod   # uses config.prod.js (production defaults)
./build.sh        # defaults to prod
```

The script copies the selected config to `config.js` and zips the extension
into `thunderclerk-ai.xpi`.

### Dev config setup

```bash
cp config.dev.js.example config.dev.js
# edit config.dev.js with your Ollama host, preferred model, etc.
```

`config.dev.js` is gitignored so your personal settings stay local.
