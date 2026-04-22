# rumi

Autonomous QA test runner. Adds a `/rumi` slash command to any Claude Code or OpenCode project.

- `/rumi` asks for a URL and explores, scopes, and tests the site in the background via two headless AI personas:
  - **FEE** — researches the project codebase to produce a `feature.md` reference and a `draft.json` with 3–8 use cases (each with 5–10 intent-level actions). Does not open the URL.
  - **QA** — runs each use case in a fresh `playwright-cli` session, marks `passed` / `failed` / `blocked` + `reason`, and writes a real `@playwright/test` spec (`tests/<id>.test.ts`) so the run is reproducible.

A live dashboard on `http://localhost:3737` (a plain Node HTTP server started on the host) renders QA progress while the loop runs, with a top-right URL dropdown to switch between sessions.

## Prerequisites

- Node.js 18+ on PATH.
- [`@playwright/cli`](https://www.npmjs.com/package/@playwright/cli) on PATH (`npm install -g @playwright/cli` — this also brings the Chromium browser the personas drive).
- Either [Claude Code](https://docs.claude.com/claude-code) or [OpenCode](https://opencode.ai/) on PATH. `rumi run` auto-detects which one launched it (env + PATH); override with `--runner claude|opencode` or `RUMI_RUNNER`.

## Install

From this repo, put `rumi` on PATH:

```bash
cd ~/me/rumi
npm install
npm run build
npm install -g .              # or `npm link` for live edits
```

Then, inside each project you want to QA:

```bash
cd ~/ws/your-project
rumi install
```

`rumi install`:

- Writes `.claude/commands/rumi.md` — `/rumi` for Claude Code.
- Writes `.opencode/command/rumi.md` — `/rumi` for OpenCode.
- Runs `playwright-cli install --skills=claude` and mirrors the resulting skill to `.opencode/skills/` so both runners discover it.
- Merges deny-list rules into `.claude/settings.json` to prevent personas from reading `node_modules`, `dist`, lock files, etc.
- Writes `rumi/config.json` with defaults if missing.

Use `--skip-playwright` to skip the skill install.

## Use

In Claude Code or OpenCode, inside the project:

```
/rumi
```

The command will ask for a URL, then run `rumi qa "<url>"` which:

1. Scaffolds `rumi/<url-slug>/{meta.json,logs.txt}` and auto-starts the dashboard on port 3737 (detached).
2. Runs the FEE → split → QA loop in-process.

Open the dashboard at `http://localhost:3737` to watch the use cases fill in live. When QA finishes, `rumi/<slug>/tests/` will contain one `<id>.test.ts` per use case — rerun them with `npx playwright test rumi/…`.

You can also pass the URL inline: `/rumi https://example.com`.

### Aborting a run

Ctrl-C in the terminal running `rumi run` stops the orchestrator and its persona subprocess. The partial state (`meta.json`, `tests/*.json`) is left on disk. Re-running `/rumi <same-url>` resumes where it stopped — use cases already in a terminal state (`passed`/`failed`/`blocked`) are skipped.

### Shutting down the dashboard

The dashboard is a detached `rumi serve` process. Stop it with:

```bash
pkill -f 'rumi .*serve'
```

(Or leave it running — it's idle and cheap.)

## Folder layout inside a project

```
rumi/
├── config.json                     # rumi config (see below)
├── sessions.json                   # index consumed by the dashboard
└── <url-slug>/                     # e.g. example_com, localhost_5173
    ├── meta.json                   # {url, createdAt} — written once at init
    ├── draft.json                  # FEE output; deleted after split into tests/
    ├── feature.md                  # FEE fills with codebase research
    ├── logs.txt                    # human-readable persona activity
    ├── logs.jsonl                  # structured {ts, persona, event, message, fields} stream
    └── tests/
        ├── <id>.json               # per-use-case state (zod-validated)
        └── <id>.test.ts            # QA-generated Playwright spec
```

Dashboard HTML/JS/CSS is shipped with the rumi package and served from there; only `sessions.json` and each session's `meta.json` / `tests/*.json` / `logs.txt` / `tests/*.test.ts` come from the project tree.

Per-use-case file (`tests/<id>.json`):

```ts
{
  id: string,              // snake_case of name, e.g. create_a_new_timed_gift
  name: string,
  description: string,
  actions: string[],       // intent-level prose steps; QA resolves them against a live snapshot
  status: "pending" | "running" | "passed" | "failed" | "blocked",
  reason: string | null,   // set on failed / blocked
  updatedAt: string        // ISO-8601, auto-set on each write
}
```

`status === "running"` is transient — QA sets it on the use case it's currently executing, writes the file so the dashboard highlights it, and then resolves it to `passed`/`failed`/`blocked`. If QA crashes or times out, the orchestrator force-sets the status to `blocked`.

## Configuration

`rumi init` writes `rumi/config.json` with the defaults below if missing. Edit it to tune timeouts or pin a runner:

```jsonc
{
  "dashboardPort": 3737,
  "runner": null,                // "claude" | "opencode" to pin; null = auto-detect
  "timeouts": {
    "personaRunMs": 1800000      // 30 min — max wall-clock per persona subprocess
  }
}
```

Playwright-specific timeouts (`actionTimeout: 30_000`, `navigationTimeout: 60_000`, `test.setTimeout(180_000)`) are baked into the generated `.test.ts` specs by the QA persona template, not read from config.

Re-running `rumi init` never overwrites a user-edited `config.json`. CLI flags (`--runner`, `--port`) still win over config values.

**Bash-tool timeout**: the `/rumi` slash command calls `rumi qa` with `timeout: 600000` (the 10-min Bash tool max) — per-persona timeouts are controlled separately via `personaRunMs` above.

## Subcommands

| Command | Purpose |
|---|---|
| `rumi install [--skip-playwright]` | Wire `/rumi` into the current project, write default config, install the `playwright-cli` skill, and merge deny-list rules into `.claude/settings.json`. |
| `rumi init <url> [--no-dashboard] [--port <n>]` | Scaffold a session dir for `<url>`, start the dashboard. Idempotent — re-running on the same URL resumes the existing session. Prints the session path on the last line of stdout. |
| `rumi serve [--port <n>]` | Run the dashboard HTTP server on `:3737` (foreground). |
| `rumi run <session> [--runner claude\|opencode]` | Run the orchestrator loop (FEE → split → QA) over an existing session directory. |
| `rumi qa <url> [--runner claude\|opencode] [--no-dashboard] [--port <n>]` | One-shot: `init` + `run` combined. This is what the `/rumi` slash command calls. |

All commands accept `--project-root <path>` to override the working directory.

## Design notes

- **One file per use case under `tests/`**. The orchestrator re-reads each `tests/<id>.json` between persona invocations and zod-validates on every read/write. A crashed child doesn't corrupt the loop.
- **Subprocess-per-persona**. Each persona runs in a fresh `claude -p` / `opencode run` so context stays small and the child is forced to re-read state each turn.
- **Host-process runtime**. Orchestrator and each persona run as plain Node/CLI subprocesses on the host; Ctrl-C on `rumi run` stops the orchestrator and its child. No containers, no network translation — `localhost` in `meta.json#url` just works.
- **Artefacts stay with the project.** `meta.json`, `feature.md`, `logs.txt`, `tests/<id>.test.ts`, and `config.json` are all written into the project's `rumi/` tree. You can run the generated `@playwright/test` specs with `npx playwright test`, commit them to git, etc.
- **Browser automation via the `playwright-cli` skill**, not `@playwright/mcp`. `playwright-cli install --skills=claude` runs on the host during `rumi install`; the skill files are mirrored to `.opencode/skills/` so both runners discover them.
- **Project-level install only**. Nothing pollutes `~/.claude` or `~/.config` — the child runners reuse your existing sessions via your normal login state.

## Development

Source lives here; edit freely and rebuild after changes.

```bash
npm run dev          # tsc --watch
npm run build        # tsc
npm test             # build + node --test test/
```

Repo layout:

```
src/
├── cli.ts                # commander entry (init, serve, run, qa, install)
├── commands/             # init, serve, run, install
├── lib/                  # config, paths, runner, logger, split-draft, tests-io, dashboard-server
└── templates/            # /rumi slash command + persona prompts (FEE, QA)
dashboard/                # static dashboard (served by `rumi serve`)
test/                     # node:test suite
```
