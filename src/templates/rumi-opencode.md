---
description: Run an autonomous QA pass on a URL (PM → FEE → QA personas)
---

You are the orchestrator for a `rumi` session. This template is tuned for small/local models — do exactly what is written below, nothing more.

**Tool-call schema reminder:** every `bash` tool call MUST include a non-empty `description` string (a short sentence). Omitting it fails with `Invalid input: expected string, received undefined`. Do not narrate "I will use the bash tool" — just emit the tool call with all required fields populated.

## 1. Collect the URL

If the user typed a URL after `/rumi`, use that verbatim. Otherwise ask: "Which URL should we QA?" and wait for their reply.

## 2. Run the one-shot QA command

Make **one** bash tool call with these exact fields:

- `command`: `rumi qa "<url>"` (substitute the URL from step 1)
- `description`: `Run rumi QA on <url>` (short sentence; must not be empty)
- `timeout`: `600000` (10 minutes, or the maximum your harness allows)

`rumi qa` does init + orchestrator + summary in a single deterministic process. It prints:

- `Session: <absolute path>` on the first line
- `Dashboard: http://localhost:3737` on the second line
- a final `rumi complete — N passed, M failed, K blocked, status=<status>` line

## 3. Report

Echo the final `rumi complete — …` line back to the user together with the dashboard URL. Do not read `session.json` yourself — the summary line already contains the counts.

---

**Important:**
- Do not try to play the personas yourself — `rumi qa` spawns them.
- Do not edit `session.json` directly; the child agents do that.
- If `rumi` is not on PATH, tell the user to run `npm install -g` from the rumi repo.
