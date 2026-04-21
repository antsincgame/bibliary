// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Editable profiles panel — встраивается в Models route.
 * Список профилей (BIG/SMALL + custom), кнопки Add/Edit/Delete.
 *
 * @param {object} opts
 * @param {() => Promise<void>} opts.onChange — вызывается после upsert/remove
 * @returns {HTMLElement & { refresh: () => Promise<void> }}
 */
export function buildProfileManager(opts) {
  const root = el("div", { class: "profile-manager" });

  async function refresh() {
    clear(root);
    /** @type {any[]} */
    const profiles = await window.api.profile.list().catch(() => []);

    const list = el("div", { class: "pm-list" });
    for (const p of profiles) {
      list.appendChild(buildProfileRow(p));
    }
    root.appendChild(list);

    const actions = el("div", { class: "pm-actions" }, [
      el(
        "button",
        { class: "btn btn-gold", type: "button", "data-action": "add" },
        t("pm.add")
      ),
      el(
        "button",
        { class: "btn btn-ghost", type: "button", "data-action": "export" },
        t("pm.export")
      ),
      el(
        "button",
        { class: "btn btn-ghost", type: "button", "data-action": "import" },
        t("pm.import")
      ),
      el(
        "button",
        { class: "btn btn-ghost", type: "button", "data-action": "reset", "data-mode-min": "advanced" },
        t("pm.reset")
      ),
    ]);
    actions.querySelector('[data-action="add"]').addEventListener("click", () =>
      openProfileEditor(null, async () => {
        await refresh();
        await opts.onChange();
      })
    );
    actions.querySelector('[data-action="export"]').addEventListener("click", async () => {
      try {
        const r = await window.api.profile.export();
        if (r) alert(t("pm.export.ok", { path: r.path }));
      } catch (e) {
        alert(t("pm.error.export", { msg: e instanceof Error ? e.message : String(e) }));
      }
    });
    actions.querySelector('[data-action="import"]').addEventListener("click", async () => {
      try {
        const r = await window.api.profile.import();
        if (r) {
          await refresh();
          await opts.onChange();
          const s = /** @type {any} */ (r.summary);
          alert(t("pm.import.ok", { count: s.profilesUpserted, roles: s.rolesImported ? "✓" : "—" }));
        }
      } catch (e) {
        alert(t("pm.error.import", { msg: e instanceof Error ? e.message : String(e) }));
      }
    });
    actions.querySelector('[data-action="reset"]').addEventListener("click", async () => {
      if (!confirm(t("pm.reset.confirm"))) return;
      try {
        await window.api.profile.resetToDefaults();
        await refresh();
        await opts.onChange();
      } catch (e) {
        alert(t("pm.error.reset", { msg: e instanceof Error ? e.message : String(e) }));
      }
    });
    root.appendChild(actions);
  }

  function buildProfileRow(p) {
    const row = el("div", { class: "pm-row" }, [
      el("div", { class: "pm-row-main" }, [
        el("div", { class: "pm-row-label" }, p.label),
        el("div", { class: "pm-row-meta" }, `${p.modelKey} · ${p.quant} · ${p.sizeGB} GB · ${p.minVramGB} GB VRAM`),
      ]),
      p.builtin ? el("span", { class: "pm-builtin-badge" }, t("pm.builtin")) : null,
    ]);
    const buttons = el("div", { class: "pm-row-actions" });
    const editBtn = el("button", { class: "btn btn-ghost pm-btn-edit", type: "button" }, t("pm.edit"));
    editBtn.addEventListener("click", () =>
      openProfileEditor(p, async () => {
        await refresh();
        await opts.onChange();
      })
    );
    buttons.appendChild(editBtn);
    if (!p.builtin) {
      const delBtn = el("button", { class: "btn btn-ghost pm-btn-delete", type: "button" }, t("pm.delete"));
      delBtn.addEventListener("click", async () => {
        if (!confirm(t("pm.delete.confirm", { id: p.id }))) return;
        try {
          await window.api.profile.remove(p.id);
          await refresh();
          await opts.onChange();
        } catch (e) {
          alert(t("pm.error.delete", { msg: e instanceof Error ? e.message : String(e) }));
        }
      });
      buttons.appendChild(delBtn);
    }
    row.appendChild(buttons);
    return row;
  }

  void refresh();
  /** @type {any} */
  const api = root;
  api.refresh = refresh;
  return api;
}

/**
 * Модальный редактор профиля. Если existing == null — создание.
 */
function openProfileEditor(existing, onSaved) {
  const overlay = el("div", { class: "pm-overlay", role: "dialog", "aria-modal": "true" });
  const form = el("form", { class: "pm-form" });
  const seed = existing || {
    id: "",
    label: "",
    modelKey: "",
    quant: "Q4_K_M",
    sizeGB: 4,
    minVramGB: 6,
    capabilities: ["tool"],
    ttlSec: 600,
    defaultContextLength: 32768,
    builtin: false,
  };

  const fields = [
    { name: "id", labelKey: "pm.field.id", type: "text", required: true, disabled: !!existing },
    { name: "label", labelKey: "pm.field.label", type: "text", required: true },
    { name: "modelKey", labelKey: "pm.field.modelKey", type: "text", required: true },
    { name: "quant", labelKey: "pm.field.quant", type: "text" },
    { name: "sizeGB", labelKey: "pm.field.sizeGB", type: "number", step: "0.01" },
    { name: "minVramGB", labelKey: "pm.field.minVramGB", type: "number", step: "1" },
    { name: "ttlSec", labelKey: "pm.field.ttlSec", type: "number", step: "60" },
    { name: "defaultContextLength", labelKey: "pm.field.defaultContextLength", type: "number", step: "1024" },
  ];

  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  for (const f of fields) {
    const input = /** @type {HTMLInputElement} */ (el("input", {
      type: f.type,
      class: "pm-input",
      name: f.name,
      step: f.step || "",
      value: String(seed[f.name] ?? ""),
      required: f.required ? "true" : null,
      disabled: f.disabled ? "true" : null,
    }));
    inputs[f.name] = input;
    form.appendChild(
      el("div", { class: "pm-field" }, [
        el("label", { class: "pm-field-label" }, t(f.labelKey)),
        input,
      ])
    );
  }

  const cap = /** @type {HTMLInputElement} */ (el("input", {
    type: "text",
    class: "pm-input",
    name: "capabilities",
    value: (seed.capabilities || []).join(", "),
  }));
  form.appendChild(el("div", { class: "pm-field" }, [
    el("label", { class: "pm-field-label" }, t("pm.field.capabilities")),
    cap,
  ]));

  const errBox = el("div", { class: "pm-error", "aria-live": "polite" });
  form.appendChild(errBox);

  const footer = el("div", { class: "pm-form-actions" }, [
    el("button", { class: "btn btn-ghost", type: "button", "data-action": "cancel" }, t("pm.cancel")),
    el("button", { class: "btn btn-gold", type: "submit" }, t(existing ? "pm.save" : "pm.create")),
  ]);
  form.appendChild(footer);

  footer.querySelector('[data-action="cancel"]').addEventListener("click", () => overlay.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.textContent = "";
    try {
      const payload = {
        id: inputs.id.value.trim(),
        label: inputs.label.value.trim(),
        modelKey: inputs.modelKey.value.trim(),
        quant: inputs.quant.value.trim() || "Q4_K_M",
        sizeGB: Number(inputs.sizeGB.value) || 0,
        minVramGB: Number(inputs.minVramGB.value) || 0,
        capabilities: cap.value.split(",").map((s) => s.trim()).filter(Boolean),
        ttlSec: Number(inputs.ttlSec.value) || 600,
        defaultContextLength: Number(inputs.defaultContextLength.value) || 32768,
        builtin: seed.builtin || false,
      };
      await window.api.profile.upsert(payload);
      overlay.remove();
      await onSaved();
    } catch (err) {
      errBox.textContent = err instanceof Error ? err.message : String(err);
    }
  });

  overlay.appendChild(form);
  document.body.appendChild(overlay);
}
