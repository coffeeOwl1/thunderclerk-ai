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

## Privacy

Email content is sent to the Ollama host you configure — by default your own machine. Nothing is sent to the extension developer or any third party. See [PRIVACY.md](PRIVACY.md) for details.

## License

GPL v3 — see [LICENSE](LICENSE).

The CalendarTools experiment API is adapted from [ThunderAI Sparks](https://micz.it/thunderbird-addon-thunderai/#sparks) by Mic (m@micz.it), Copyright (C) 2024-2025, GPL v3.

## Development

```bash
npm install        # install Jest for tests
npm test           # unit tests (~136 cases)
npm run test:integration  # integration tests (needs running Ollama)
```

To configure the Ollama host/model for integration tests, copy the example
config and edit it:

```bash
cp config.test.js.example config.test.js
# edit config.test.js with your Ollama host and model
```

Environment variables (`OLLAMA_HOST`, `OLLAMA_MODEL`) override the config file.

### Building

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
