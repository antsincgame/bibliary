// @ts-check
/**
 * Custom Olympics disciplines editor — UI для CRUD пользовательских тестов.
 *
 * Создан 2026-05-05 (Iter 14.3, приказ Императора).
 *
 * UX:
 *   - collapsible-блок в Settings (закрыт по умолчанию: «продвинутая
 *     возможность для библиотекарей и башук»);
 *   - список существующих тестов с роли + название + действия (edit/delete);
 *   - кнопка «Создать тест» открывает форму с полями:
 *       роль | название | описание | system prompt | user prompt | expected
 *       answer | maxTokens | thinkingFriendly | image (если vision-роль).
 *
 * Никаких регулярок / JSON-схем / диапазонов — единственный scorer
 * (fuzzy similarity) на бэкенде. Пользователь думает в терминах
 * «вот какой ответ я ожидаю» — система меряет насколько модель близка.
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { showAlert, showConfirm } from "../components/ui-dialog.js";

/** @returns {any} */
function api() { return /** @type {any} */ (window).api; }

const ROLES = /** @type {const} */ ([
  "crystallizer",
  "evaluator",
  "vision_ocr",
  "vision_illustration",
]);

/** @param {string} role */
function roleRequiresImage(role) {
  return role === "vision_ocr" || role === "vision_illustration";
}

/** @param {string} role */
function roleLabel(role) {
  const key = `models.olympics.role.${role}`;
  const v = t(key);
  return v === key ? role : v;
}

/** Slugify name → id segment. */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "test";
}

function makeId(role, name) {
  return `custom-${role}-${slugify(name)}-${Date.now().toString(36)}`;
}

/**
 * Public: создаёт collapsible-блок «Свои тесты Олимпиады» для вставки
 * в settings.js. Блок сам управляет своим состоянием (загрузка списка,
 * открытие модалки редактора, save/delete).
 *
 * @returns {HTMLElement}
 */
export function buildCustomDisciplinesEditor() {
  const root = el("details", { class: "settings-custom-disciplines" }, [
    el("summary", { class: "settings-custom-disciplines-summary" }, [
      el("span", { class: "settings-custom-disciplines-title" }, t("settings.customDisciplines.title")),
      el("span", { class: "settings-custom-disciplines-hint" }, t("settings.customDisciplines.hint")),
    ]),
  ]);

  const body = el("div", { class: "settings-custom-disciplines-body" });
  root.appendChild(body);

  const list = el("div", { class: "scd-list" }, t("settings.customDisciplines.loading"));
  body.appendChild(list);

  const actionsRow = el("div", { class: "scd-actions" }, [
    el("button", {
      class: "neon-btn neon-btn-primary",
      type: "button",
      onclick: () => openEditor(null, refresh),
    }, t("settings.customDisciplines.create")),
  ]);
  body.appendChild(actionsRow);

  async function refresh() {
    clear(list);
    list.appendChild(el("span", { class: "scd-list-loading" }, t("settings.customDisciplines.loading")));
    try {
      const items = await api().arena.customDisciplines.list();
      clear(list);
      if (!Array.isArray(items) || items.length === 0) {
        list.appendChild(el("p", { class: "scd-empty" }, t("settings.customDisciplines.empty")));
        return;
      }
      const grid = el("div", { class: "scd-grid" });
      for (const it of items) {
        grid.appendChild(buildItemCard(it, refresh));
      }
      list.appendChild(grid);
    } catch (e) {
      clear(list);
      list.appendChild(el("p", { class: "scd-error" }, t("settings.customDisciplines.loadFailed") + ": " + (e instanceof Error ? e.message : String(e))));
    }
  }

  /* Загружаем список только если details открыт — это лёгкий performance
     win и предотвращает лишний IPC при mount Settings. */
  root.addEventListener("toggle", () => {
    if (root.open && list.dataset.loaded !== "1") {
      list.dataset.loaded = "1";
      void refresh();
    }
  });

  return root;
}

/**
 * @param {any} item
 * @param {() => Promise<void>} onChange
 */
function buildItemCard(item, onChange) {
  const card = el("div", { class: "scd-card" });
  card.appendChild(el("div", { class: "scd-card-head" }, [
    el("span", { class: `scd-card-role scd-card-role-${item.role}` }, roleLabel(item.role)),
    el("span", { class: "scd-card-name" }, item.name || item.id),
  ]));
  if (item.description) {
    card.appendChild(el("p", { class: "scd-card-desc" }, item.description));
  }
  const meta = el("div", { class: "scd-card-meta" }, [
    el("span", {}, t("settings.customDisciplines.maxTokens") + ": " + (item.maxTokens || 800)),
    item.imageRef ? el("span", {}, "image: " + item.imageRef) : null,
    item.thinkingFriendly ? el("span", {}, "🧠 thinking") : null,
  ].filter(Boolean));
  card.appendChild(meta);

  const actions = el("div", { class: "scd-card-actions" }, [
    el("button", {
      class: "neon-btn",
      type: "button",
      onclick: () => openEditor(item, onChange),
    }, t("settings.customDisciplines.edit")),
    el("button", {
      class: "neon-btn neon-btn-danger",
      type: "button",
      onclick: async () => {
        const ok = await showConfirm(t("settings.customDisciplines.confirmDelete", { name: item.name || item.id }));
        if (!ok) return;
        try {
          await api().arena.customDisciplines.delete(item.id);
          await onChange();
        } catch (e) {
          await showAlert(t("settings.customDisciplines.deleteFailed") + ": " + (e instanceof Error ? e.message : String(e)));
        }
      },
    }, t("settings.customDisciplines.delete")),
  ]);
  card.appendChild(actions);
  return card;
}

/**
 * Модалка редактора. Если `existing` — режим edit (id неизменяемый, role
 * неизменяемая, потому что меняет шкалу шкорить и могут понадобиться
 * картинки). Если null — режим create.
 *
 * @param {any | null} existing
 * @param {() => Promise<void>} onSaved
 */
function openEditor(existing, onSaved) {
  /* Закрываем существующую модалку чтобы не плодить overlay.
     Если она была открыта через openEditor() — её closeModal() уже
     сделал cleanup. Старый код просто delete'ил DOM, оставляя keydown
     listener висеть на document — теперь страховка через ручной remove. */
  const stale = document.getElementById("scd-editor-overlay");
  if (stale) {
    /** @type {any} */ (stale).__scdCleanup?.();
    stale.remove();
  }

  /* Запоминаем фокус-источник для return on close (user rule "Modal").
     Может быть null если модалка открыта программно. */
  const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);
  /* Block body scroll (user rule "Prevent body scroll when open"). */
  const previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const overlay = el("div", { id: "scd-editor-overlay", class: "scd-overlay", role: "dialog", "aria-modal": "true" });
  const modal = el("div", { class: "scd-modal" });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const isEdit = !!existing;
  const initialRole = existing?.role || "crystallizer";

  modal.appendChild(el("h3", { class: "scd-modal-title" },
    isEdit ? t("settings.customDisciplines.editTitle") : t("settings.customDisciplines.createTitle")
  ));

  const fields = el("div", { class: "scd-form" });
  modal.appendChild(fields);

  /* Role select (locked в edit mode). */
  const roleSelect = /** @type {HTMLSelectElement} */ (el("select", { class: "scd-input", disabled: isEdit }));
  for (const r of ROLES) {
    roleSelect.appendChild(el("option", { value: r }, roleLabel(r)));
  }
  roleSelect.value = initialRole;
  fields.appendChild(buildField(t("settings.customDisciplines.field.role"), roleSelect));

  /* Name. */
  const nameInput = /** @type {HTMLInputElement} */ (el("input", {
    type: "text",
    class: "scd-input",
    value: existing?.name || "",
    maxlength: "120",
    placeholder: t("settings.customDisciplines.field.name.placeholder"),
  }));
  fields.appendChild(buildField(t("settings.customDisciplines.field.name"), nameInput));

  /* Description (optional). */
  const descInput = /** @type {HTMLTextAreaElement} */ (el("textarea", {
    class: "scd-input scd-textarea-small",
    rows: "2",
    maxlength: "400",
    placeholder: t("settings.customDisciplines.field.description.placeholder"),
  }));
  descInput.value = existing?.description || "";
  fields.appendChild(buildField(t("settings.customDisciplines.field.description"), descInput));

  /* System prompt. */
  const systemInput = /** @type {HTMLTextAreaElement} */ (el("textarea", {
    class: "scd-input scd-textarea",
    rows: "4",
    maxlength: "4000",
    placeholder: t("settings.customDisciplines.field.system.placeholder"),
  }));
  systemInput.value = existing?.system || "";
  fields.appendChild(buildField(t("settings.customDisciplines.field.system"), systemInput));

  /* User / sample. */
  const userInput = /** @type {HTMLTextAreaElement} */ (el("textarea", {
    class: "scd-input scd-textarea",
    rows: "6",
    maxlength: "20000",
    placeholder: t("settings.customDisciplines.field.user.placeholder"),
  }));
  userInput.value = existing?.user || "";
  fields.appendChild(buildField(t("settings.customDisciplines.field.user"), userInput));

  /* Expected answer. */
  const expectedInput = /** @type {HTMLTextAreaElement} */ (el("textarea", {
    class: "scd-input scd-textarea",
    rows: "4",
    maxlength: "20000",
    placeholder: t("settings.customDisciplines.field.expected.placeholder"),
  }));
  expectedInput.value = existing?.expectedAnswer || "";
  fields.appendChild(buildField(t("settings.customDisciplines.field.expected"), expectedInput, t("settings.customDisciplines.field.expected.hint")));

  /* maxTokens. */
  const tokensInput = /** @type {HTMLInputElement} */ (el("input", {
    type: "number",
    class: "scd-input",
    min: "64",
    max: "8000",
    value: String(existing?.maxTokens || 800),
  }));
  fields.appendChild(buildField(t("settings.customDisciplines.field.maxTokens"), tokensInput));

  /* Thinking-friendly. */
  const thinkingInput = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "scd-checkbox",
  }));
  thinkingInput.checked = !!existing?.thinkingFriendly;
  fields.appendChild(buildField(t("settings.customDisciplines.field.thinking"), thinkingInput, t("settings.customDisciplines.field.thinking.hint")));

  /* Image upload (только для vision-ролей). */
  const imageBlock = el("div", { class: "scd-image-block" });
  fields.appendChild(buildField(t("settings.customDisciplines.field.image"), imageBlock));
  /** @type {{ pendingBase64: string, pendingExt: string, currentImageRef: string | undefined }} */
  const imageState = {
    pendingBase64: "",
    pendingExt: "",
    currentImageRef: existing?.imageRef,
  };
  function renderImageBlock() {
    clear(imageBlock);
    const role = roleSelect.value;
    if (!roleRequiresImage(role)) {
      imageBlock.appendChild(el("p", { class: "scd-image-disabled" }, t("settings.customDisciplines.field.image.notForRole")));
      return;
    }
    const fileInput = /** @type {HTMLInputElement} */ (el("input", {
      type: "file",
      accept: "image/png,image/jpeg,image/jpg,image/webp",
      class: "scd-input",
    }));
    const previewWrap = el("div", { class: "scd-image-preview" });
    if (imageState.currentImageRef) {
      previewWrap.appendChild(el("p", { class: "scd-image-current" },
        t("settings.customDisciplines.image.current") + " " + imageState.currentImageRef
      ));
      void api().arena.customDisciplines.getImage(imageState.currentImageRef)
        .then((/** @type {any} */ r) => {
          if (r?.dataUrl) {
            const img = el("img", { src: r.dataUrl, class: "scd-image-preview-img", alt: "discipline image" });
            previewWrap.appendChild(img);
          }
        });
    }
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const MAX = 5 * 1024 * 1024;
      if (file.size > MAX) {
        await showAlert(t("settings.customDisciplines.image.tooLarge"));
        fileInput.value = "";
        return;
      }
      const rawExt = (file.name.split(".").pop() || "").toLowerCase();
      const ALLOWED_EXTS = ["png", "jpg", "jpeg", "webp"];
      if (!ALLOWED_EXTS.includes(rawExt)) {
        await showAlert(t("settings.customDisciplines.image.unsupportedExt"));
        fileInput.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onerror = async () => {
        await showAlert(t("settings.customDisciplines.image.readFailed"));
        fileInput.value = "";
      };
      reader.onload = async () => {
        const dataUrl = String(reader.result || "");
        const idx = dataUrl.indexOf("base64,");
        const payload = idx >= 0 ? dataUrl.slice(idx + 7) : "";
        if (!payload) {
          await showAlert(t("settings.customDisciplines.image.readFailed"));
          fileInput.value = "";
          imageState.pendingBase64 = "";
          imageState.pendingExt = "";
          return;
        }
        imageState.pendingBase64 = payload;
        imageState.pendingExt = rawExt;
        clear(previewWrap);
        previewWrap.appendChild(el("p", { class: "scd-image-current" }, t("settings.customDisciplines.image.pending")));
        previewWrap.appendChild(el("img", { src: dataUrl, class: "scd-image-preview-img", alt: "preview" }));
      };
      reader.readAsDataURL(file);
    });
    imageBlock.appendChild(fileInput);
    imageBlock.appendChild(previewWrap);
  }
  renderImageBlock();
  roleSelect.addEventListener("change", renderImageBlock);

  /* Footer buttons. */
  const errBox = el("div", { class: "scd-error", style: "display:none" });
  modal.appendChild(errBox);

  function showError(msg) {
    errBox.textContent = msg;
    errBox.style.display = "block";
  }
  function hideError() {
    errBox.style.display = "none";
  }

  /* Centralized close: cleanup keydown listener, разблокировать body scroll,
     вернуть фокус на источник. Раньше обработчики Esc / backdrop / Cancel
     дёргали overlay.remove() напрямую и забывали про removeEventListener →
     leak document.keydown listener'а на каждое открытие. */
  function closeModal() {
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = previousBodyOverflow;
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === "function" && document.body.contains(previouslyFocused)) {
      try { previouslyFocused.focus(); } catch { /* noop */ }
    }
  }
  /* Страховка для следующего openEditor() — он умеет дёрнуть наш cleanup
     даже если кто-то снаружи удалит overlay через DOM.remove(). */
  /** @type {any} */ (overlay).__scdCleanup = closeModal;

  const footer = el("div", { class: "scd-footer" });
  footer.appendChild(el("button", {
    class: "neon-btn",
    type: "button",
    onclick: () => closeModal(),
  }, t("settings.customDisciplines.cancel")));

  const saveBtn = /** @type {HTMLButtonElement} */ (el("button", {
    class: "neon-btn neon-btn-primary",
    type: "button",
  }, t("settings.customDisciplines.save")));
  saveBtn.addEventListener("click", async () => {
    hideError();
    const role = roleSelect.value;
    const name = nameInput.value.trim();
    if (!name) { showError(t("settings.customDisciplines.error.nameRequired")); return; }
    const system = systemInput.value.trim();
    if (!system) { showError(t("settings.customDisciplines.error.systemRequired")); return; }
    const user = userInput.value.trim();
    if (!user) { showError(t("settings.customDisciplines.error.userRequired")); return; }
    const expected = expectedInput.value.trim();
    if (!expected) { showError(t("settings.customDisciplines.error.expectedRequired")); return; }
    const maxTokens = Number(tokensInput.value) || 800;
    const id = existing?.id || makeId(role, name);

    /* Save image first if vision and pending. */
    let imageRef = imageState.currentImageRef;
    if (roleRequiresImage(role)) {
      if (imageState.pendingBase64) {
        try {
          const r = await api().arena.customDisciplines.saveImage({
            disciplineId: id,
            base64: imageState.pendingBase64,
            ext: imageState.pendingExt,
          });
          imageRef = r?.imageRef;
        } catch (e) {
          showError(t("settings.customDisciplines.error.imageSaveFailed") + ": " + (e instanceof Error ? e.message : String(e)));
          return;
        }
      }
      if (!imageRef) {
        showError(t("settings.customDisciplines.error.imageRequired"));
        return;
      }
    } else {
      imageRef = undefined;
    }

    saveBtn.disabled = true;
    try {
      await api().arena.customDisciplines.save({
        id,
        role,
        name,
        description: descInput.value.trim() || "",
        system,
        user,
        expectedAnswer: expected,
        maxTokens,
        thinkingFriendly: thinkingInput.checked,
        imageRef,
      });
      closeModal();
      await onSaved();
    } catch (e) {
      showError(t("settings.customDisciplines.error.saveFailed") + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      saveBtn.disabled = false;
    }
  });
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  /* Esc + Tab focus-trap. Tab/Shift+Tab loops внутри модалки (user rule
     "Trap focus inside modal"). Для пустого focusable-набора focus
     остаётся где есть. */
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = /** @type {HTMLElement[]} */ (Array.from(
      modal.querySelectorAll("button, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")
    )).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  /* Click on backdrop closes. */
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  /* Initial focus — на первый редактируемый input. Без него фокус
     остаётся на body, и focus trap не сможет начать loop. */
  setTimeout(() => {
    const target = isEdit ? nameInput : roleSelect;
    try { target.focus(); } catch { /* noop */ }
  }, 0);

  /* Trap focus into first input. */
  setTimeout(() => nameInput.focus(), 0);
}

function buildField(label, control, hint) {
  return el("div", { class: "scd-field" }, [
    el("label", { class: "scd-label" }, label),
    control,
    hint ? el("p", { class: "scd-field-hint" }, hint) : null,
  ].filter(Boolean));
}
