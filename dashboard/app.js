(() => {
  const state = { sessions: [], current: null };

  const $ = (id) => document.getElementById(id);

  async function loadSessions() {
    try {
      const res = await fetch(`sessions.json?_=${Date.now()}`);
      if (!res.ok) throw new Error(`sessions.json ${res.status}`);
      state.sessions = await res.json();
    } catch (e) {
      state.sessions = [];
    }
    renderUrlDropdown();

    if (state.sessions.length === 0) {
      $("empty").classList.remove("hidden");
      $("summary").classList.add("hidden");
      $("logs").classList.add("hidden");
      $("use-cases").innerHTML = "";
      return;
    }
    $("empty").classList.add("hidden");

    if (!state.current || !state.sessions.find((s) => s.path === state.current)) {
      state.current = state.sessions[state.sessions.length - 1].path;
      syncDropdownSelection();
    }
    await loadSession(state.current);
  }

  function renderUrlDropdown() {
    const select = $("url-select");
    select.innerHTML = "";
    state.sessions.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.path;
      opt.textContent = s.url || s.slug;
      select.appendChild(opt);
    });
    syncDropdownSelection();
    select.onchange = () => {
      state.current = select.value;
      loadSession(state.current);
    };
  }

  function syncDropdownSelection() {
    const select = $("url-select");
    if (state.current) select.value = state.current;
  }

  async function loadSession(relPath) {
    const metaUrl = `${relPath}/meta.json?_=${Date.now()}`;
    const indexUrl = `${relPath}/tests-index.json?_=${Date.now()}`;
    const jsonlUrl = `${relPath}/logs.jsonl?_=${Date.now()}`;
    const txtUrl = `${relPath}/logs.txt?_=${Date.now()}`;

    try {
      const [mr, ir, jr] = await Promise.all([
        fetch(metaUrl),
        fetch(indexUrl),
        fetch(jsonlUrl),
      ]);
      const meta = mr.ok ? await mr.json() : { url: "", createdAt: "" };
      const index = ir.ok ? await ir.json() : { files: [] };

      const useCases = await Promise.all(
        index.files.map(async (name) => {
          const r = await fetch(`${relPath}/tests/${name}?_=${Date.now()}`);
          if (!r.ok) return null;
          try { return await r.json(); } catch { return null; }
        }),
      );

      let logsText = "";
      if (jr.ok) {
        logsText = renderJsonlLogs(await jr.text());
      } else {
        const lr = await fetch(txtUrl);
        logsText = lr.ok ? await lr.text() : "";
      }

      renderSession(meta, useCases.filter(Boolean));
      renderLogs(logsText);
    } catch (e) {
      $("summary").classList.add("hidden");
      $("use-cases").innerHTML = `<p class="empty">Failed to load session: ${e.message}</p>`;
      $("logs").classList.add("hidden");
    }
  }

  function renderJsonlLogs(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines
      .map((l) => {
        try {
          const ev = JSON.parse(l);
          const tag = ev.event ? `[${ev.event}] ` : "";
          return `${ev.ts} | ${String(ev.persona || "").toUpperCase()} | ${tag}${ev.message || ""}`;
        } catch {
          return l;
        }
      })
      .join("\n");
  }

  function deriveStatus(useCases) {
    if (useCases.length === 0) return "scoping";
    const passed = useCases.filter((u) => u.status === "passed").length;
    const failed = useCases.filter((u) => u.status === "failed").length;
    const blocked = useCases.filter((u) => u.status === "blocked").length;
    const running = useCases.filter((u) => u.status === "running").length;
    const terminal = passed + failed + blocked;
    if (terminal === useCases.length) return "complete";
    if (running > 0 || terminal > 0) return "testing";
    return "ready";
  }

  function renderSession(meta, useCases) {
    $("summary").classList.remove("hidden");
    const urlEl = $("url");
    urlEl.href = meta.url || "#";
    urlEl.textContent = meta.url || "";
    const status = deriveStatus(useCases);
    const statusEl = $("status");
    statusEl.className = `badge ${status}`;
    statusEl.textContent = status;

    const passed = useCases.filter((u) => u.status === "passed").length;
    const failed = useCases.filter((u) => u.status === "failed").length;
    const blocked = useCases.filter((u) => u.status === "blocked").length;
    const pending = useCases.length - passed - failed - blocked;
    $("description").textContent = "";
    $("counts").textContent = `${useCases.length} total · ${passed} passed · ${failed} failed · ${blocked} blocked · ${pending} pending`;

    const list = $("use-cases");
    list.innerHTML = "";
    useCases.forEach((uc) => {
      const div = document.createElement("div");
      div.className = "uc";
      const actions = (uc.actions || [])
        .map((a) => `<li>${escape(a)}</li>`)
        .join("");
      div.innerHTML = `
        <div class="uc-head">
          <h3><span class="id">${escape(uc.id)}</span>${escape(uc.name)}</h3>
          <span class="badge ${uc.status || "pending"}">${uc.status || "pending"}</span>
        </div>
        <p class="desc">${escape(uc.description || "")}</p>
        ${actions ? `<ol>${actions}</ol>` : ""}
        ${uc.reason ? `<div class="reason">✗ ${escape(uc.reason)}</div>` : ""}
      `;
      list.appendChild(div);
    });
  }

  function renderLogs(text) {
    $("logs").classList.remove("hidden");
    const lines = text.split(/\r?\n/).filter(Boolean);
    $("logs-body").textContent = lines.slice(-50).join("\n");
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  loadSessions();
  setInterval(loadSessions, 2000);
})();
