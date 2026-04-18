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
    const sessionUrl = `${relPath}/session.json?_=${Date.now()}`;
    const logsUrl = `${relPath}/logs.txt?_=${Date.now()}`;

    try {
      const [sr, lr] = await Promise.all([fetch(sessionUrl), fetch(logsUrl)]);
      if (!sr.ok) throw new Error(`session.json ${sr.status}`);
      const session = await sr.json();
      const logs = lr.ok ? await lr.text() : "";
      renderSession(session);
      renderLogs(logs);
    } catch (e) {
      $("summary").classList.add("hidden");
      $("use-cases").innerHTML = `<p class="empty">Failed to load session: ${e.message}</p>`;
      $("logs").classList.add("hidden");
    }
  }

  function renderSession(p) {
    $("summary").classList.remove("hidden");
    const urlEl = $("url");
    urlEl.href = p.url;
    urlEl.textContent = p.url;
    const status = $("status");
    status.className = `badge ${p.status}`;
    status.textContent = p.status;
    $("description").textContent = p.description || "(no description yet)";

    const passed = p.useCases.filter((u) => u.status === "passed").length;
    const failed = p.useCases.filter((u) => u.status === "failed").length;
    const blocked = p.useCases.filter((u) => u.status === "blocked").length;
    const pending = p.useCases.length - passed - failed - blocked;
    $("counts").textContent = `${p.useCases.length} total · ${passed} passed · ${failed} failed · ${blocked} blocked · ${pending} pending`;

    const list = $("use-cases");
    list.innerHTML = "";
    p.useCases.forEach((uc) => {
      const div = document.createElement("div");
      div.className = "uc";
      const actions = (uc.actions || []).map((a) => `<li>${escape(a)}</li>`).join("");
      div.innerHTML = `
        <div class="uc-head">
          <h3><span class="id">${escape(uc.id)}</span>${escape(uc.title)}</h3>
          <span class="badge ${uc.status || "draft"}">${uc.status || "draft"}</span>
        </div>
        <p class="desc">${escape(uc.description)}</p>
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
