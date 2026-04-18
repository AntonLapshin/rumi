---
description: Run an autonomous QA pass on a URL (PM → FEE → QA personas)
---

You are the orchestrator for a `rumi` session. Follow these steps exactly and keep messages terse.

## 1. Collect the URL

If the user typed a URL after `/rumi`, use it. Otherwise ask: "Which URL should we QA?" and wait for their reply.

## 2. Scaffold the session

Run:

```bash
rumi init "<url>"
```

Capture the **last line of stdout** — that's the absolute path to the session directory. Store it as `SESSION`. `rumi init` also auto-starts the dashboard on port 3737 (idempotent — skipped if it's already up). Tell the user: "Dashboard: http://localhost:3737".

## 3. Run the persona loop

```bash
rumi run "$SESSION"
```

This blocks. It will spawn headless `opencode run` subprocesses for each persona (PM → FEE → QA), re-reading `session.json` between iterations until status is `complete` or the safety cap is hit.

**Use a long shell timeout** (≥10 min) for this call — persona loops often take longer than default caps. Per-persona subprocess timeouts are controlled separately inside `rumi/config.json` (`timeouts.personaRunMs`, default 30 min); edit that file if you need to tune them.

## 4. Report

When `rumi run` exits, read `$SESSION/session.json` and summarize in one or two sentences: counts of passed / failed / blocked use cases and the dashboard URL.

---

**Important:**
- Do not try to play the personas yourself — the orchestrator spawns them.
- Do not edit `session.json` directly; the child agents do that.
- If `rumi` is not on PATH, tell the user to run `npm install -g` from the rumi repo.
