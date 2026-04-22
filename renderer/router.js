import { mountChat } from "./chat.js";
import { mountModels } from "./models/models-page.js";
import { mountDocs } from "./docs.js";
import { mountForge } from "./forge.js";
import { mountLibrary, isLibraryBusy } from "./library.js";
import { mountAgent, isAgentBusy } from "./forge-agent.js";
import { mountCrystal, isCrystalBusy } from "./dataset-v2.js";
import { mountQdrant } from "./qdrant.js";
import { mountSettings } from "./settings.js";
import { applyI18n, getLocale, setLocale, listLocales, onLocaleChange, t } from "./i18n.js";
import { mountResilienceBar } from "./components/resilience-bar.js";
import { getMode, cycleMode, applyToDocument as applyMode, onModeChange } from "./ui-mode.js";
import { openWelcomeWizard } from "./components/welcome-wizard.js";
import { maybeShowRebrandToast } from "./components/changelog-toast.js";

const ROUTES = ["chat", "library", "qdrant", "agent", "crystal", "models", "forge", "docs", "settings"];
const REMOUNT_ON_LOCALE = new Set(["library", "qdrant", "agent", "crystal", "models", "forge", "docs", "settings"]);
const mounted = new Set();

function mountRoute(name) {
  if (name === "chat") mountChat();
  else if (name === "library") mountLibrary(document.getElementById("library-root"));
  else if (name === "qdrant") mountQdrant(document.getElementById("qdrant-root"));
  else if (name === "agent") mountAgent(document.getElementById("agent-root"));
  else if (name === "crystal") mountCrystal(document.getElementById("crystal-root"));
  else if (name === "models") mountModels(document.getElementById("models-root"));
  else if (name === "forge") mountForge(document.getElementById("forge-root"));
  else if (name === "docs") mountDocs(document.getElementById("docs-root"));
  else if (name === "settings") mountSettings(document.getElementById("settings-root"));
  mounted.add(name);
}

function showRoute(name) {
  if (!ROUTES.includes(name)) return;
  document.querySelectorAll(".route").forEach((el) => el.classList.remove("route-active"));
  document.getElementById(`route-${name}`)?.classList.add("route-active");
  document.querySelectorAll(".sidebar-icon").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
  });
  if (!mounted.has(name)) mountRoute(name);
}

function canRemount(name) {
  // Не выкидывать прогресс ingest книг при смене языка.
  if (name === "library" && isLibraryBusy()) return false;
  // Не убивать активный agent loop сменой локали.
  if (name === "agent" && isAgentBusy()) return false;
  // То же для активной crystallization job.
  if (name === "crystal" && isCrystalBusy()) return false;
  return true;
}

function setupLanguageToggle() {
  const btn = document.getElementById("btn-lang");
  if (!btn) return;
  const label = btn.querySelector(".lang-current");
  const order = listLocales();
  const refresh = (loc) => {
    if (label) label.textContent = loc.toUpperCase();
  };
  refresh(getLocale());
  btn.addEventListener("click", () => {
    const cur = getLocale();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setLocale(next);
  });
  onLocaleChange((loc) => {
    refresh(loc);
    for (const name of REMOUNT_ON_LOCALE) {
      if (!mounted.has(name)) continue;
      if (!canRemount(name)) continue;
      const root = document.getElementById(`${name}-root`);
      if (root) {
        delete root.dataset.mounted;
        root.innerHTML = "";
      }
      mountRoute(name);
    }
    // Обновляем title/aria у sidebar-кнопок и других статических узлов.
    applyI18n(document);
  });
}

document.querySelectorAll(".sidebar-icon").forEach((btn) => {
  btn.addEventListener("click", () => showRoute(btn.dataset.route));
});

function setupUiModeToggle() {
  const btn = document.getElementById("btn-ui-mode");
  if (!btn) return;
  const label = document.getElementById("mode-current-label");
  const refresh = (mode) => {
    if (label) label.textContent = mode === "simple" ? "SIM" : mode === "advanced" ? "ADV" : "PRO";
    btn.dataset.mode = mode;
    btn.title = t(`mode.${mode}.title`);
  };
  refresh(getMode());
  btn.addEventListener("click", () => {
    cycleMode();
  });
  onModeChange(refresh);
}

applyMode();
applyI18n(document);
setupLanguageToggle();
setupUiModeToggle();
mountResilienceBar();

/* Phase 3 Удар 3: source of truth для onboarding — preferences.onboardingDone.
   Legacy localStorage["bibliary_setup_done"] поддерживается как fallback и
   мигрируется в prefs при первом обнаружении. */
(async () => {
  let onboardingDone = false;
  try {
    const prefs = /** @type {any} */ (await window.api.preferences.getAll());
    onboardingDone = prefs?.onboardingDone === true;
  } catch { /* prefs недоступны — значит свежий запуск */ }

  /* Миграция legacy → prefs (одноразовая) */
  const legacyDone = localStorage.getItem("bibliary_setup_done") === "1";
  if (legacyDone && !onboardingDone) {
    onboardingDone = true;
    try {
      await window.api.preferences.set({ onboardingDone: true, onboardingVersion: 1 });
      localStorage.removeItem("bibliary_setup_done");
    } catch { /* следующий запуск повторит миграцию */ }
  }

  showRoute("chat");
  if (!onboardingDone) {
    openWelcomeWizard({ force: true });
  } else {
    /* Существующие пользователи: показать changelog-toast о ребрендинге v2.4
       (Forge → Дообучение, Crystallizer → Извлечение знаний, Memory Forge →
       Расширение контекста). Новички увидят актуальные термины в wizard. */
    void maybeShowRebrandToast();
  }
})();

// Tiny self-test: убедиться, что i18n загружен (иначе в логах увидим warning).
if (typeof t !== "function") {
  console.warn("[router] i18n is not initialised");
}
