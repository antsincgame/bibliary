import { mountChat } from "./chat.js";
import { mountDataset, isDatasetBatchActive } from "./dataset.js";
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

const ROUTES = ["chat", "library", "qdrant", "agent", "crystal", "dataset", "models", "forge", "docs", "settings"];
const REMOUNT_ON_LOCALE = new Set(["library", "qdrant", "agent", "crystal", "dataset", "models", "forge", "docs", "settings"]);
const mounted = new Set();

function mountRoute(name) {
  if (name === "chat") mountChat();
  else if (name === "library") mountLibrary(document.getElementById("library-root"));
  else if (name === "qdrant") mountQdrant(document.getElementById("qdrant-root"));
  else if (name === "agent") mountAgent(document.getElementById("agent-root"));
  else if (name === "crystal") mountCrystal(document.getElementById("crystal-root"));
  else if (name === "dataset") mountDataset(document.getElementById("dataset-root"));
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
  // Не пересоздавать вкладку датасета во время активного батча — DOM прогресса
  // должен жить, иначе пользователь "потеряет" экран генерации при смене языка.
  if (name === "dataset" && isDatasetBatchActive()) return false;
  // Аналогично — не выкидывать прогресс ingest книг при смене языка.
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
/* Первый запуск (wizard не пройдён) → models/setup, потом → chat */
const setupDone = localStorage.getItem("bibliary_setup_done") === "1";
showRoute(setupDone ? "chat" : "models");
// Welcome wizard на первый запуск (тихо игнорируется если уже пройден).
openWelcomeWizard();

// Экспортируем хелпер для других модулей, если им нужен переход через JS.
export function navigate(name) {
  showRoute(name);
}

// Tiny self-test: убедиться, что i18n загружен (иначе в логах увидим warning).
if (typeof t !== "function") {
  // eslint-disable-next-line no-console
  console.warn("[router] i18n is not initialised");
}
