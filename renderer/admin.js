// @ts-check
/**
 * Phase 11d/11e — admin panel SPA route.
 *
 * Four tabs:
 *   Users   — list + promote/demote/deactivate/reactivate/delete
 *   Jobs    — cross-user job inspection + admin cancel
 *   Storage — per-user storage usage aggregator
 *   Audit   — audit_log viewer with filters
 *
 * Mounted only when window.api.auth.meOrNull() returns a user with
 * role==="admin" (gated by sidebar visibility + server-side
 * requireAdmin on every endpoint).
 */
import { el, clear } from "./dom.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";

const STATE = {
  tab: /** @type {"users" | "jobs" | "storage" | "audit"} */ ("users"),
  /* Users */
  users: /** @type {import("./api-client/admin.js").AdminUserRow[]} */ ([]),
  usersTotal: 0,
  usersOffset: 0,
  /* Jobs */
  jobs: /** @type {import("./api-client/admin.js").AdminJobRow[]} */ ([]),
  jobsTotal: 0,
  jobsState: /** @type {string | undefined} */ (undefined),
  depth: /** @type {{pending: number, active: number} | null} */ (null),
  /* Storage */
  storageUserId: "",
  storage: /** @type {import("./api-client/admin.js").StorageUsage | null} */ (null),
  /* Audit */
  audit: /** @type {import("./api-client/admin.js").AuditRow[]} */ ([]),
  auditTotal: 0,
  auditFilterAction: "",
};

const PAGE_SIZE = 50;

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return iso;
  }
}

function fmtError(e) {
  return e instanceof Error ? e.message : String(e);
}

/* ─── Users tab ─── */

async function loadUsers(root) {
  try {
    const r = /** @type {any} */ (
      await window.api.admin.listUsers({ limit: PAGE_SIZE, offset: STATE.usersOffset })
    );
    STATE.users = r.rows ?? [];
    STATE.usersTotal = r.total ?? 0;
  } catch (e) {
    await showAlert(`Failed to load users: ${fmtError(e)}`);
  }
  renderUsers(root);
}

function renderUsers(root) {
  const box = root.querySelector(".admin-tab-body");
  if (!box) return;
  clear(box);
  if (STATE.users.length === 0) {
    box.append(el("div", { class: "admin-empty" }, "No users."));
    return;
  }
  const table = el("table", { class: "admin-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Email"),
        el("th", {}, "Role"),
        el("th", {}, "Status"),
        el("th", {}, "Created"),
        el("th", {}, "Last login"),
        el("th", {}, "Actions"),
      ]),
    ]),
    el("tbody", {}, STATE.users.map((u) => userRow(u, root))),
  ]);
  box.append(table);
  box.append(paginator(STATE.usersOffset, STATE.usersTotal, (newOffset) => {
    STATE.usersOffset = newOffset;
    void loadUsers(root);
  }));
}

function userRow(u, root) {
  const promoteOrDemote = u.role === "admin"
    ? el("button", {
        type: "button",
        class: "admin-btn admin-btn-ghost",
        onclick: () => void confirmAndRun(
          `Demote ${u.email} to regular user?`,
          () => window.api.admin.demote(u.id),
          root,
          loadUsers,
        ),
      }, "Demote")
    : el("button", {
        type: "button",
        class: "admin-btn admin-btn-ghost",
        onclick: () => void confirmAndRun(
          `Promote ${u.email} to admin?`,
          () => window.api.admin.promote(u.id),
          root,
          loadUsers,
        ),
      }, "Promote");

  const activateBtn = u.deactivated
    ? el("button", {
        type: "button",
        class: "admin-btn admin-btn-ghost",
        onclick: () => void confirmAndRun(
          `Reactivate ${u.email}?`,
          () => window.api.admin.reactivate(u.id),
          root,
          loadUsers,
        ),
      }, "Reactivate")
    : el("button", {
        type: "button",
        class: "admin-btn admin-btn-warn",
        onclick: () => void confirmAndRun(
          `Deactivate ${u.email}? All their sessions will be revoked.`,
          () => window.api.admin.deactivate(u.id),
          root,
          loadUsers,
        ),
      }, "Deactivate");

  const deleteBtn = el("button", {
    type: "button",
    class: "admin-btn admin-btn-danger",
    onclick: () => void confirmAndRun(
      `IRREVERSIBLY delete ${u.email}? This will burn all their books, concepts, vectors, storage files, and graph edges.`,
      () => window.api.admin.deleteUser(u.id),
      root,
      loadUsers,
    ),
  }, "Delete");

  return el("tr", {}, [
    el("td", { class: "admin-cell-email" }, [
      el("div", {}, u.email),
      el("div", { class: "admin-cell-sub" }, u.name || ""),
    ]),
    el("td", {}, [
      el("span", {
        class: u.role === "admin" ? "admin-badge admin-badge-admin" : "admin-badge",
      }, u.role),
    ]),
    el("td", {}, u.deactivated
      ? el("span", { class: "admin-badge admin-badge-danger" }, "deactivated")
      : el("span", { class: "admin-badge admin-badge-ok" }, "active")),
    el("td", { class: "admin-cell-ts" }, fmtDate(u.createdAt)),
    el("td", { class: "admin-cell-ts" }, fmtDate(u.lastLoginAt)),
    el("td", { class: "admin-cell-actions" }, [promoteOrDemote, activateBtn, deleteBtn]),
  ]);
}

async function confirmAndRun(prompt, fn, root, reload) {
  if (!(await showConfirm(prompt))) return;
  try {
    await fn();
  } catch (e) {
    await showAlert(`Failed: ${fmtError(e)}`);
  }
  await reload(root);
}

/* ─── Jobs tab ─── */

async function loadJobs(root) {
  try {
    const args = { limit: PAGE_SIZE };
    if (STATE.jobsState) args.state = STATE.jobsState;
    const r = /** @type {any} */ (await window.api.admin.listJobs(args));
    STATE.jobs = r.rows ?? [];
    STATE.jobsTotal = r.total ?? 0;
    STATE.depth = /** @type {any} */ (await window.api.admin.jobsDepth());
  } catch (e) {
    await showAlert(`Failed to load jobs: ${fmtError(e)}`);
  }
  renderJobs(root);
}

function renderJobs(root) {
  const box = root.querySelector(".admin-tab-body");
  if (!box) return;
  clear(box);

  const depthBadge = STATE.depth
    ? el("div", { class: "admin-depth" },
        `Queue depth: ${STATE.depth.pending} pending · ${STATE.depth.active} active`)
    : null;

  const stateOptions = ["", "queued", "running", "done", "failed", "cancelled"];
  const filter = el("div", { class: "admin-filter" }, [
    el("label", {}, "State filter:"),
    el("select", {
      class: "admin-select",
      onchange: (ev) => {
        STATE.jobsState = /** @type {HTMLSelectElement} */ (ev.target).value || undefined;
        void loadJobs(root);
      },
    }, stateOptions.map((s) =>
      el("option", { value: s, selected: STATE.jobsState === s || (!STATE.jobsState && s === "") ? "selected" : null }, s || "all"),
    )),
  ]);

  box.append(filter);
  if (depthBadge) box.append(depthBadge);

  if (STATE.jobs.length === 0) {
    box.append(el("div", { class: "admin-empty" }, "No jobs."));
    return;
  }

  const table = el("table", { class: "admin-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Job"),
        el("th", {}, "User"),
        el("th", {}, "State"),
        el("th", {}, "Book"),
        el("th", {}, "Collection"),
        el("th", {}, "Concepts"),
        el("th", {}, "Updated"),
        el("th", {}, "Action"),
      ]),
    ]),
    el("tbody", {}, STATE.jobs.map((j) => jobRow(j, root))),
  ]);
  box.append(table);
}

function jobRow(j, root) {
  const cancelBtn = ["queued", "running"].includes(j.state)
    ? el("button", {
        type: "button",
        class: "admin-btn admin-btn-warn",
        onclick: () => void confirmAndRun(
          `Cancel job ${j.id.slice(0, 8)}…?`,
          () => window.api.admin.cancelJob(j.id),
          root,
          loadJobs,
        ),
      }, "Cancel")
    : el("span", { class: "admin-cell-sub" }, "—");

  return el("tr", {}, [
    el("td", { class: "admin-cell-mono", title: j.id }, j.id.slice(0, 8) + "…"),
    el("td", { class: "admin-cell-mono", title: j.userId }, j.userId.slice(0, 8) + "…"),
    el("td", {}, [
      el("span", { class: `admin-badge admin-badge-state-${j.state}` }, j.state),
    ]),
    el("td", { class: "admin-cell-mono" }, j.bookId ? j.bookId.slice(0, 8) + "…" : "—"),
    el("td", {}, j.targetCollection || "—"),
    el("td", {}, String(j.conceptsExtracted ?? 0)),
    el("td", { class: "admin-cell-ts" }, fmtDate(j.updatedAt)),
    el("td", { class: "admin-cell-actions" }, [cancelBtn]),
  ]);
}

/* ─── Storage tab ─── */

async function loadStorage(root) {
  if (!STATE.storageUserId) {
    STATE.storage = null;
    renderStorage(root);
    return;
  }
  try {
    STATE.storage = /** @type {any} */ (
      await window.api.admin.storageUsage(STATE.storageUserId)
    );
  } catch (e) {
    await showAlert(`Failed to compute storage: ${fmtError(e)}`);
    STATE.storage = null;
  }
  renderStorage(root);
}

function renderStorage(root) {
  const box = root.querySelector(".admin-tab-body");
  if (!box) return;
  clear(box);

  const form = el("div", { class: "admin-form-row" }, [
    el("label", {}, "User ID:"),
    el("input", {
      type: "text",
      class: "admin-input",
      placeholder: "paste a user id (see Users tab)",
      value: STATE.storageUserId,
      oninput: (ev) => {
        STATE.storageUserId = /** @type {HTMLInputElement} */ (ev.target).value;
      },
    }),
    el("button", {
      type: "button",
      class: "admin-btn admin-btn-primary",
      onclick: () => void loadStorage(root),
    }, "Compute"),
  ]);
  box.append(form);

  if (!STATE.storage) {
    box.append(el("div", { class: "admin-empty" }, "Enter a user id and click Compute."));
    return;
  }

  const s = STATE.storage;
  const partial = s.partial
    ? el("div", { class: "admin-warning" },
        "⚠ Partial result — deadline reached. Some files weren't counted.")
    : null;
  const card = el("div", { class: "admin-storage-card" }, [
    el("h3", {}, `${s.bookCount} books`),
    el("table", { class: "admin-table admin-table-kv" }, [
      el("tbody", {}, [
        kvRow("Originals", fmtBytes(s.bytesOriginal)),
        kvRow("Markdown", fmtBytes(s.bytesMarkdown)),
        kvRow("Covers", fmtBytes(s.bytesCovers)),
        kvRow("Dataset exports", fmtBytes(s.bytesDatasets)),
        kvRow("Total", fmtBytes(s.totalBytes), "admin-row-emph"),
      ]),
    ]),
  ]);
  box.append(card);
  if (partial) box.append(partial);
}

function kvRow(k, v, cls) {
  return el("tr", { class: cls ?? "" }, [
    el("td", { class: "admin-cell-k" }, k),
    el("td", { class: "admin-cell-v" }, v),
  ]);
}

/* ─── Audit tab ─── */

async function loadAudit(root) {
  try {
    const args = { limit: PAGE_SIZE };
    if (STATE.auditFilterAction) args.action = STATE.auditFilterAction;
    const r = /** @type {any} */ (await window.api.admin.audit(args));
    STATE.audit = r.rows ?? [];
    STATE.auditTotal = r.total ?? 0;
  } catch (e) {
    await showAlert(`Failed to load audit: ${fmtError(e)}`);
  }
  renderAudit(root);
}

function renderAudit(root) {
  const box = root.querySelector(".admin-tab-body");
  if (!box) return;
  clear(box);

  const filter = el("div", { class: "admin-filter" }, [
    el("label", {}, "Action filter:"),
    el("input", {
      type: "text",
      class: "admin-input",
      placeholder: "e.g. admin.user.delete",
      value: STATE.auditFilterAction,
      oninput: (ev) => {
        STATE.auditFilterAction = /** @type {HTMLInputElement} */ (ev.target).value;
      },
      onkeydown: (ev) => {
        if (/** @type {KeyboardEvent} */ (ev).key === "Enter") void loadAudit(root);
      },
    }),
    el("button", {
      type: "button",
      class: "admin-btn admin-btn-ghost",
      onclick: () => void loadAudit(root),
    }, "Apply"),
  ]);
  box.append(filter);

  if (STATE.audit.length === 0) {
    box.append(el("div", { class: "admin-empty" }, "No audit events match."));
    return;
  }

  const table = el("table", { class: "admin-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Time"),
        el("th", {}, "Action"),
        el("th", {}, "Actor"),
        el("th", {}, "Target"),
        el("th", {}, "Metadata"),
        el("th", {}, "IP"),
      ]),
    ]),
    el("tbody", {}, STATE.audit.map((a) => auditRow(a))),
  ]);
  box.append(table);
}

function auditRow(a) {
  const meta = a.metadata
    ? Object.entries(a.metadata)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(", ")
    : "";
  return el("tr", {}, [
    el("td", { class: "admin-cell-ts" }, fmtDate(a.createdAt)),
    el("td", { class: "admin-cell-mono" }, a.action),
    el("td", { class: "admin-cell-mono", title: a.userId ?? "" }, (a.userId ?? "—").slice(0, 8) + (a.userId ? "…" : "")),
    el("td", { class: "admin-cell-mono", title: a.target ?? "" }, (a.target ?? "—").slice(0, 8) + (a.target ? "…" : "")),
    el("td", { class: "admin-cell-meta", title: meta }, meta.length > 80 ? meta.slice(0, 80) + "…" : meta),
    el("td", { class: "admin-cell-mono" }, a.ip ?? "—"),
  ]);
}

/* ─── Shared widgets ─── */

function paginator(offset, total, onChange) {
  const pageInfo = `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`;
  return el("div", { class: "admin-paginator" }, [
    el("button", {
      type: "button",
      class: "admin-btn admin-btn-ghost",
      disabled: offset <= 0 ? "true" : null,
      onclick: () => onChange(Math.max(0, offset - PAGE_SIZE)),
    }, "← Prev"),
    el("span", { class: "admin-page-info" }, pageInfo),
    el("button", {
      type: "button",
      class: "admin-btn admin-btn-ghost",
      disabled: offset + PAGE_SIZE >= total ? "true" : null,
      onclick: () => onChange(offset + PAGE_SIZE),
    }, "Next →"),
  ]);
}

function switchTab(root, tab) {
  STATE.tab = tab;
  renderShell(root);
  if (tab === "users") void loadUsers(root);
  else if (tab === "jobs") void loadJobs(root);
  else if (tab === "storage") renderStorage(root);
  else if (tab === "audit") void loadAudit(root);
}

function renderShell(root) {
  clear(root);
  const tabs = ["users", "jobs", "storage", "audit"].map((t) =>
    el("button", {
      type: "button",
      class: `admin-tab ${STATE.tab === t ? "admin-tab-active" : ""}`,
      onclick: () => switchTab(root, /** @type {any} */ (t)),
    }, t.charAt(0).toUpperCase() + t.slice(1)),
  );
  root.append(el("div", { class: "admin-page" }, [
    el("header", { class: "admin-header" }, [
      el("h1", { class: "admin-title" }, "Admin"),
      el("nav", { class: "admin-tabs" }, tabs),
    ]),
    el("section", { class: "admin-tab-body" }),
  ]));
}

/** @param {HTMLElement | null} root */
export function mountAdmin(root) {
  if (!root) return;
  renderShell(root);
  switchTab(root, STATE.tab);
}
