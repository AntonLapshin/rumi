---
description: Run an autonomous QA pass on a URL (FEE → QA personas)
argument-hint: [url]
allowed-tools: [Bash, AskUserQuestion]
---

You are the entry for a `rumi` session.

1. If the user typed a URL after `/rumi`, use it. Otherwise use AskUserQuestion to ask: "Which URL should we QA?" (single free-text answer).

2. Make **one** bash tool call:
   - `command`: `rumi qa "<url>"`
   - `description`: `Run rumi QA on <url>`
   - `timeout`: `600000`

   `rumi qa` does init + FEE + split + QA-loop + summary in a single deterministic process. Dashboard starts on :3737. The last line of stdout looks like `rumi complete — N passed, M failed, K blocked, status=<status>`.

3. Echo that final line to the user together with `Dashboard: http://localhost:3737`.

Do not play the personas yourself — `rumi qa` spawns them. Do not edit files under `rumi/` — the orchestrator and child agents own them. If `rumi` is not on PATH, tell the user to run `npm install -g` from the rumi repo.
