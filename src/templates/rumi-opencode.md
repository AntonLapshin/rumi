---
description: Run an autonomous QA pass on a URL (FEE → QA personas)
---

You are the entry for a `rumi` session. This template is tuned for small/local models — do exactly what is written below.

**Tool-call schema reminder:** every `bash` tool call MUST include a non-empty `description` string. Omitting it fails with `Invalid input: expected string, received undefined`.

1. If the user typed a URL after `/rumi`, use it verbatim. Otherwise ask: "Which URL should we QA?" and wait for their reply.

2. Make **one** bash tool call with these exact fields:
   - `command`: `rumi qa "<url>"` (substitute the URL)
   - `description`: `Run rumi QA on <url>`
   - `timeout`: `600000`

3. The command prints a final `rumi complete — N passed, M failed, K blocked, status=<status>` line. Echo that back to the user with `Dashboard: http://localhost:3737`.

Do not play the personas yourself. Do not edit files under `rumi/`. If `rumi` is not on PATH, tell the user to run `npm install -g` from the rumi repo.
