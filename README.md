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
- **Unsubscribe** — one-click unsubscribe via `List-Unsubscribe` header detection (Auto Analyze only, no AI needed)
- **Bulk Triage** — select multiple emails, right-click "Bulk Triage" to see a priority-sorted summary view. Cached emails show priority badge, summary, and item counts; uncached emails can be queued for analysis. Batch Archive/Delete with checkboxes, per-card View (opens full Auto Analyze dialog) and Archive buttons. Sort by priority (default) or date.
- **Auto Analyze** — one-click analysis from the message header toolbar button (next to Reply/Forward), or via `Ctrl+Shift+E`. Shows a summary, priority scoring, detected events/tasks/contacts ("What I Found") as clickable Add buttons, a suggested AI reply, and Quick Actions including one-click Unsubscribe for newsletters (detected via `List-Unsubscribe` header). Priority scoring rates each email as urgent (red badge), action-needed (orange), informational (green), or low (grey) — the toolbar badge color reflects the priority at a glance, and non-default priority levels show a label in the dialog. The toolbar badge also shows item count when cached results exist, "…" when queued for processing, "✓" when analyzed with nothing found, "!" on error. Includes background processing: incoming emails are automatically analyzed so results display instantly. Existing emails are backfilled on startup; manual actions always take priority. Archive/Delete checkboxes for post-triage cleanup. Also available via right-click context menu. Disabled by default — requires a 20B+ parameter model (see settings).
- **Ollama Status Indicator** — toolbar button with a colored badge dot shows Ollama connectivity at a glance: green (connected), red (unreachable), orange (checking). Updates every 30 seconds and reacts instantly to processor errors. Click to open settings. Auto-resumes background processing when Ollama comes back online.
- AI extracts title, dates, times, attendees, and (optionally) category
- Reads the full email body — no need to select text first
- All processing is done locally via your own Ollama instance
- Auto-tagging can run in the background after any other action
- **Cache-first actions** — when Auto Analyze background processing has already analyzed an email, all individual actions (Add to Calendar, Add as Task, Draft Reply, Summarize & Forward, Extract Contact, Catalog Email) use cached results instantly instead of making an LLM call. Falls back to on-demand LLM when no cache exists.
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
| Auto-select category (events) | Off | Ask the AI to pick the best category for calendar events |
| Auto-select category (tasks) | Off | Ask the AI to pick the best category for tasks |
| Draft Reply Mode | Reply to sender | Whether "Draft Reply" replies to the sender only or to all recipients |
| Default Address Book | (first available) | Which address book to save extracted contacts to |
| Auto-tag after actions | On | Automatically tag emails after using other actions |
| Allow new tags | Off | Let the AI create new tags (experimental — may clutter your tag list) |
| Context Window (tokens) | 0 (model default) | Override the model's context window size. Controls KV cache VRAM usage. |
| Max Output Tokens | 0 (model default) | Override the maximum generation length. Thinking/reasoning models need 8192+. |
| Enable Auto Analyze | Off | Enables one-click analysis, background processing of incoming emails, toolbar button with badge, and the keyboard shortcut. Requires a 20B+ parameter model with at least 16 GB VRAM. Smaller models produce unreliable results. |
| Cache duration | 1 day | How long to keep cached analysis results. Options: 1/3/7/14/30 days. |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+E` | Auto Analyze the displayed email (same as clicking the toolbar button) |

You can customize the shortcut in **Add-ons Manager → gear icon → Manage Extension Shortcuts**.

## Permissions

The extension requests these permissions:

- **messagesRead** — read email content for AI analysis
- **messagesMove** — archive emails (via Auto Analyze)
- **messagesDelete** — delete emails (via Auto Analyze)
- **messageDisplay** — detect which message is open (for toolbar button badge and keyboard shortcut)
- **menus** — add right-click context menu items
- **storage** — save settings
- **compose** — create reply/forward drafts
- **addressBooks** — save extracted contacts
- **notifications** — show progress/error notifications
- **messagesTags / messagesTagsList / messagesUpdate** — catalog/tag emails
- **accountsRead** — listen for new mail (background processing), query messages across accounts
- **\<all_urls\>** — connect to the configured Ollama host

## Privacy

Email content is sent to the Ollama host you configure — by default your own machine. Nothing is sent to the extension developer or any third party. See [PRIVACY.md](PRIVACY.md) for details.

## License

GPL v3 — see [LICENSE](LICENSE).

The CalendarTools experiment API is adapted from [ThunderAI Sparks](https://micz.it/thunderbird-addon-thunderai/#sparks) by Mic (m@micz.it), Copyright (C) 2024-2025, GPL v3.

## Development

```bash
npm install        # install Jest for tests
npm test           # unit tests (~203 cases)
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
