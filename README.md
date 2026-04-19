# rumi

Autonomous QA test runner. Adds a `/rumi` slash command to any Claude Code or OpenCode project. The orchestrator, personas, and Chromium all run inside a single Docker container per session, so one `docker kill` reaps everything without leaving zombies.

- `/rumi` asks for a URL and explores, scopes, and tests the site in the background via three headless AI personas:
  - **PM** — researches the codebase to produce a `feature.md` reference, opens the URL with the `playwright-cli` skill, and drafts a description + 3–8 use cases.
  - **FEE** — searches the project codebase and fills 5–15 imperative `actions` per use case, adding any gaps the PM missed (and updating `feature.md` in place if it finds inconsistencies).
  - **QA** — runs each use case in a fresh `playwright-cli` session, marks `passed` / `failed` + `reason`, and writes a real `@playwright/test` spec (`e2e/<id>.test.ts`) alongside `session.json` so the run is reproducible.

A live dashboard on `http://localhost:3737` (served from a long-lived `rumi-dashboard` container) renders QA progress while the loop runs, with a top-right URL dropdown to switch between sessions.

## Prerequisites

- Docker Desktop (or any Docker CLI + running daemon).
- Node.js 18+ on PATH (only for building/installing the rumi CLI itself).
- Either [Claude Code](https://docs.claude.com/claude-code) or [OpenCode](https://opencode.ai/) on PATH. `rumi run` auto-detects which one launched it (env + PATH); override with `--runner claude|opencode` or `RUMI_RUNNER`.

No host-side Playwright install is required — `@playwright/cli` and the Chromium browser live inside the image.

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

The first `rumi install` on a machine builds the `rumi:local` Docker image automatically (pulls `node:20-bookworm`, Chromium + system libs — ~1.5 GB, a few minutes). Subsequent projects reuse the cached image.

`rumi install` drops:

- `.claude/commands/rumi.md` — `/rumi` for Claude Code
- `.opencode/command/rumi.md` — `/rumi` for OpenCode
- `.claude/skills/playwright/…` — the browser-automation skill (installed by a one-shot `playwright-cli install-skills` run inside the container)
- `rumi/config.json` — defaults listed below; edit freely

It also ensures the Docker image is available: builds `rumi:local` from this package's source the first time, or `docker pull`s the configured tag for any non-default image.

Use `--skip-playwright` to skip the skill install, `--skip-image` to skip the image check/build, or `--image <tag>` to point at a different image.

## Use

In Claude Code or OpenCode, inside the project:

```
/rumi
```

The command will ask for a URL, then:

1. `rumi init "<url>"` (on the host) scaffolds `rumi/<url-slug>/{session.json,logs.txt}`.
2. `rumi serve --background` (on the host) starts/reuses the long-lived `rumi-dashboard` container on port 3737.
3. `rumi run "<session>"` (on the host) launches an ephemeral `rumi-run-<slug>` container that runs the PM → FEE → QA loop inside.

Open the dashboard at `http://localhost:3737` to watch the use cases fill in live. When QA finishes, `rumi/<slug>/e2e/` will contain one `<id>.test.ts` per use case — rerun them on the host with `npx playwright test rumi/…`. No Playwright browsers are required on the host for the *autonomous* run (they live in the image); you only need them on the host to re-run the generated specs yourself.

You can also pass the URL inline: `/rumi https://example.com`.

### Dev server must bind to all interfaces

If you're QA-ing a local dev server (e.g. `http://localhost:5173`), start it with `--host` so it binds `0.0.0.0` instead of `127.0.0.1`. Otherwise it'll refuse connections from inside the Docker container (which reaches the host via `host.docker.internal`, a different interface than pure loopback):

```bash
npm run dev -- --host            # Vite
next dev -H 0.0.0.0              # Next.js
python -m http.server --bind 0.0.0.0 5173   # plain Python
```

rumi translates `localhost` / `127.0.0.1` in `session.json#url` to `host.docker.internal` automatically when making browser calls, but only `--host`-bound dev servers will actually accept those connections. The orchestrator does a preflight check at the start of each run and prints a clear hint if the URL is unreachable.

### Aborting a run

The whole point of containerisation: `docker kill` on the run container reaps orchestrator, persona subprocesses, and Chromium together — no stray `claude`, `node`, or `chrome` processes left on the host. In another terminal:

```bash
docker ps                          # find the rumi-run-<slug> container
docker kill rumi-run-<slug>
```

The partial `session.json` is left on disk. Re-running `/rumi <same-url>` resumes where it stopped.

### Shutting down the dashboard

```bash
docker stop rumi-dashboard
```

(Or leave it running — it's idle and cheap.)

## Folder layout inside a project

```
rumi/
├── config.json                     # rumi config (see below)
├── sessions.json                   # index consumed by the dashboard
└── <url-slug>/                     # e.g. example_com, localhost_5173
    ├── session.json                # zod-validated state
    ├── feature.md                  # auto-written by PM from codebase research
    ├── logs.txt                    # timestamped persona activity
    └── e2e/
        └── <id>.test.ts            # one @playwright/test spec per QA'd use case
```

Dashboard HTML/JS/CSS is **not** copied into the project — those assets live inside the Docker image and the dashboard container serves them directly, while reading `sessions.json` and each `session.json` live from the bind-mounted `rumi/` directory.

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
    actions?: string[],
    status?: "draft" | "ready" | "testing" | "passed" | "failed" | "blocked",
    reason?: string        // only set on failed / blocked
  }>,
  createdAt: string        // ISO8601
}
```

`useCase.status === "testing"` is transient — QA sets it on the use case it's currently running, writes the file so the dashboard highlights it, and then resolves it to `passed`/`failed`/`blocked`.

## Configuration

`rumi init` scaffolds `rumi/config.json` with the defaults below. Edit it to tune timeouts, pin a runner, or point at a different image:

```jsonc
{
  "dashboardPort": 3737,
  "runner": null,                // "claude" | "opencode" to pin; null = auto-detect
  "image": "rumi:local",         // docker image tag used for run / serve containers
  "timeouts": {
    "personaRunMs": 1800000,     // 30 min — max per persona subprocess (enforced via `docker kill`)
    "playwrightActionMs": 30000, // 30 s — baked into `test.use({ actionTimeout })` of generated specs
    "playwrightNavigationMs": 60000 // 60 s — baked into `test.use({ navigationTimeout })`
  }
}
```

Re-running `rumi init` never overwrites a user-edited `config.json`. CLI flags (`--runner`, `--port`, `--image`) still win over config values.

**Bash-tool timeout**: when the `/rumi` slash command calls `rumi run` from Claude Code, set the Bash tool's `timeout` parameter to 600000 (the 10-min max) — per-persona timeouts are controlled separately via `personaRunMs` above.

## Subcommands

| Command | Purpose |
|---|---|
| `rumi install [--skip-playwright] [--skip-image] [--image <tag>]` | Wire `/rumi` into the current project, write default config, install the `playwright-cli` skill (in-container), and verify the docker image. |
| `rumi init <url>` | Scaffold a session dir for `<url>`. Idempotent — re-running on the same URL resumes the existing session. Prints the session path on the last line of stdout. |
| `rumi serve [--background] [--port <n>]` | Start (or reuse) the `rumi-dashboard` container on `:3737`. |
| `rumi run <session> [--runner claude\|opencode] [--max-iterations N]` | Launch an ephemeral `rumi-run-<slug>` container that runs the orchestrator loop (PM → FEE → QA) inside. |
| `rumi log <persona> <message>` | Append a timestamped line to the active session's `logs.txt`. Used by child personas from inside the container. |

## Design notes

- **One source of truth is `session.json`**. The orchestrator doesn't parse child stdout — it re-reads state between persona invocations and zod-validates on every read/write. A crashed child doesn't corrupt the loop.
- **Subprocess-per-persona**. Each persona runs in a fresh `claude -p` / `opencode run` so context stays small and the child is forced to re-read state each turn.
- **Containerised runtime**. Orchestrator + personas + Chromium all run inside a single per-session container as children of PID 1; `docker kill` collapses the whole tree. Host-side `rumi run`/`serve` are thin shims around `docker run`; the same CLI detects `RUMI_IN_CONTAINER=1` and does the real work inside.
- **Artefacts stay on the host.** The project folder is bind-mounted into `/work`; `session.json`, `feature.md`, `logs.txt`, `e2e/<id>.test.ts`, and `config.json` are all written to the host tree. You can run the generated `@playwright/test` specs outside the container with `npx playwright test`, commit them to git, etc.
- **Browser automation via the `playwright-cli` skill**, not `@playwright/mcp`. `playwright-cli install-skills` runs in a one-shot container during `rumi install`, writing the skill files to `.claude/skills/playwright/` on the host so child agents discover it on the next mount.
- **Project-level install only**. Nothing pollutes `~/.claude` or `~/.config` — the container mounts `~/.claude` and `~/.opencode` read-write so the child runners reuse your existing sessions, but nothing is *written* outside the mounted project and your existing auth dirs.

## Development

Source lives here; edit freely and rebuild the image when persona prompts / CLI code change.

```bash
npm run dev          # tsc --watch
npm run build        # tsc
docker build -t rumi:local .   # rebuild after persona / dashboard / CLI changes
```

Repo layout:

```
src/
├── cli.ts                # commander entry
├── commands/             # init, serve, run, install, log
├── lib/                  # schema, paths, runner, logger, session-io, config, docker, dashboard-server
└── templates/            # /rumi slash command + persona prompts
dashboard/                # static dashboard (baked into the image)
Dockerfile                # image definition
```
