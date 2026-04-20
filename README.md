# rumi

Autonomous QA test runner. Adds a `/rumi` slash command to any Claude Code or OpenCode project.

- `/rumi` asks for a URL and explores, scopes, and tests the site in the background via three headless AI personas:
  - **PM** — researches the codebase to produce a `feature.md` reference, opens the URL with the `playwright-cli` skill, and drafts a description + 3–8 use cases.
  - **FEE** — searches the project codebase and fills 5–15 imperative `actions` per use case, adding any gaps the PM missed (and updating `feature.md` in place if it finds inconsistencies).
  - **QA** — runs each use case in a fresh `playwright-cli` session, marks `passed` / `failed` + `reason`, and writes a real `@playwright/test` spec (`e2e/<id>.test.ts`) alongside `session.json` so the run is reproducible.

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

`rumi install` drops:

- `.claude/commands/rumi.md` — `/rumi` for Claude Code
- `.opencode/command/rumi.md` — `/rumi` for OpenCode
- `.claude/skills/playwright/…` — the browser-automation skill (installed by `playwright-cli install --skills=claude`)
- `rumi/config.json` — defaults listed below; edit freely

Use `--skip-playwright` to skip the skill install.

## Use

In Claude Code or OpenCode, inside the project:

```
/rumi
```

The command will ask for a URL, then:

1. `rumi init "<url>"` scaffolds `rumi/<url-slug>/{session.json,logs.txt}` and auto-starts the dashboard on port 3737 (detached).
2. `rumi run "<session>"` runs the PM → FEE → QA loop in-process.

Open the dashboard at `http://localhost:3737` to watch the use cases fill in live. When QA finishes, `rumi/<slug>/e2e/` will contain one `<id>.test.ts` per use case — rerun them with `npx playwright test rumi/…`.

You can also pass the URL inline: `/rumi https://example.com`.

### Aborting a run

Ctrl-C in the terminal running `rumi run` stops the orchestrator and its persona subprocess. The partial `session.json` is left on disk. Re-running `/rumi <same-url>` resumes where it stopped.

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
    ├── session.json                # zod-validated state
    ├── session.json.bak            # previous valid state, auto-recovered if primary is corrupt
    ├── feature.md                  # scaffolded at init; PM fills canonical sections
    ├── logs.txt                    # human-readable persona activity
    ├── logs.jsonl                  # structured {ts, persona, event, fields} stream
    └── e2e/
        └── <id>.test.ts            # scaffold + TODO(qa) block; QA fills in Playwright steps from live snapshots
```

Dashboard HTML/JS/CSS is shipped with the rumi install and served from there; only `sessions.json` and each `session.json` / `logs.txt` / `e2e/*.test.ts` come from the project tree.

`session.json`:

```ts
{
  url: string,
  description: string,
  status: "initialized" | "scoping" | "ready" | "testing" | "complete",
  useCases: Array<{
    id: string,            // snake_case of title, e.g. create_a_new_timed_gift
    title: string,
    description: string,
    actions?: string[],    // intent-level prose steps; QA resolves them against a live snapshot
    status?: "draft" | "ready" | "testing" | "passed" | "failed" | "blocked",
    reason?: string        // only set on failed / blocked
  }>,
  createdAt: string        // ISO8601
}
```

`useCase.status === "testing"` is transient — QA sets it on the use case it's currently running, writes the file so the dashboard highlights it, and then resolves it to `passed`/`failed`/`blocked`.

## Configuration

`rumi init` scaffolds `rumi/config.json` with the defaults below. Edit it to tune timeouts or pin a runner:

```jsonc
{
  "dashboardPort": 3737,
  "runner": null,                // "claude" | "opencode" to pin; null = auto-detect
  "timeouts": {
    "personaRunMs": 1800000,      // 30 min — max per persona subprocess
    "playwrightActionMs": 30000,  // 30 s — baked into `test.use({ actionTimeout })` of generated specs
    "playwrightNavigationMs": 60000, // 60 s — baked into `test.use({ navigationTimeout })`
    "playwrightTestMs": 180000    // 3 min — baked into generated `test.setTimeout(...)` (default 30 s is too tight for multi-step tests)
  }
}
```

Re-running `rumi init` never overwrites a user-edited `config.json`. CLI flags (`--runner`, `--port`) still win over config values.

**Bash-tool timeout**: when the `/rumi` slash command calls `rumi run` from Claude Code, set the Bash tool's `timeout` parameter to 600000 (the 10-min max) — per-persona timeouts are controlled separately via `personaRunMs` above.

## Subcommands

| Command | Purpose |
|---|---|
| `rumi install [--skip-playwright]` | Wire `/rumi` into the current project, write default config, and install the `playwright-cli` skill. |
| `rumi init <url>` | Scaffold a session dir for `<url>`. Idempotent — re-running on the same URL resumes the existing session. Prints the session path on the last line of stdout. |
| `rumi serve [--port <n>]` | Run the dashboard HTTP server on `:3737` (foreground). |
| `rumi run <session> [--runner claude\|opencode] [--max-iterations N]` | Run the orchestrator loop (PM → FEE → QA) in-process. Cap auto-scales with use case count (`max(12, useCases*3 + 5)`) unless `--max-iterations` is set. |
| `rumi session <subcommand>` | Mutate or inspect `session.json` without editing it by hand. Subcommands: `set-description`, `add-use-case`, `add-action`, `set-actions`, `record-result`, `dump`, `validate`, `scaffold-feature-md`, `lint-feature-md`. Actions are intent-level prose — QA resolves them against a live snapshot. |
| `rumi preflight` | Reachability probe: open the session URL via `playwright-cli` and take one snapshot. The orchestrator runs this before each QA attempt and blocks the use case if the URL can't be loaded. |
| `rumi log <persona> <message>` | Append a timestamped line to the active session's `logs.txt`. Used by child personas. |

## Design notes

- **One source of truth is `session.json`**. The orchestrator doesn't parse child stdout — it re-reads state between persona invocations and zod-validates on every read/write. A crashed child doesn't corrupt the loop.
- **Subprocess-per-persona**. Each persona runs in a fresh `claude -p` / `opencode run` so context stays small and the child is forced to re-read state each turn.
- **Host-process runtime**. Orchestrator and each persona run as plain Node/CLI subprocesses on the host; Ctrl-C on `rumi run` stops the orchestrator and its child. No containers, no network translation — `localhost` in `session.json#url` just works.
- **Artefacts stay with the project.** `session.json`, `feature.md`, `logs.txt`, `e2e/<id>.test.ts`, and `config.json` are all written into the project's `rumi/` tree. You can run the generated `@playwright/test` specs with `npx playwright test`, commit them to git, etc.
- **Browser automation via the `playwright-cli` skill**, not `@playwright/mcp`. `playwright-cli install --skills=claude` runs on the host during `rumi install`, writing the skill files to `.claude/skills/playwright/` so child agents discover them.
- **Project-level install only**. Nothing pollutes `~/.claude` or `~/.config` — the child runners reuse your existing sessions via your normal login state.

## Development

Source lives here; edit freely and rebuild after changes.

```bash
npm run dev          # tsc --watch
npm run build        # tsc
```

Repo layout:

```
src/
├── cli.ts                # commander entry
├── commands/             # init, serve, run, install, log
├── lib/                  # schema, paths, runner, logger, session-io, config, dashboard-server
└── templates/            # /rumi slash command + persona prompts
dashboard/                # static dashboard (served by `rumi serve`)
```
