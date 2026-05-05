import { mountModels, unmountModels } from "./models/models-page.js";
import { mountLibrary, isLibraryBusy, unmountLibrary, checkPendingLibraryNav } from "./library.js";
import { mountCrystal, isCrystalBusy } from "./dataset-v2.js";
import { mountDatasets } from "./datasets.js";
import { mountSettings } from "./settings.js";
import { applyI18n, getLocale, setLocale, listLocales, onLocaleChange, t } from "./i18n.js";
import { mountResilienceBar } from "./components/resilience-bar.js";
import { openWelcomeWizard } from "./components/welcome-wizard.js";
import { mountVersionBadge } from "./components/version-badge.js";

const ROUTES = ["models", "library", "crystal", "datasets", "settings"];
const REMOUNT_ON_LOCALE = new Set([
  "library",
  "crystal",
  "datasets",
  "models",
  "settings",
]);
const mounted = new Set();

function mountRoute(name) {
  if (name === "library") mountLibrary(document.getElementById("library-root"));
  else if (name === "crystal") mountCrystal(document.getElementById("crystal-root"));
  else if (name === "datasets") mountDatasets(document.getElementById("datasets-root"));
  else if (name === "models") mountModels(document.getElementById("models-root"));
  else if (name === "settings") mountSettings(document.getElementById("settings-root"));
  mounted.add(name);
}

function unmountRoute(name) {
  if (name === "models") unmountModels();
  else if (name === "library") unmountLibrary();
}

function showRoute(name) {
  if (!ROUTES.includes(name)) return;
  document.querySelectorAll(".route").forEach((el) => el.classList.remove("route-active"));
  document.getElementById(`route-${name}`)?.classList.add("route-active");
  document.querySelectorAll(".sidebar-icon").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
  });
  if (!mounted.has(name)) mountRoute(name);
  /* checkPendingLibraryNav резервный хук на случай если sessionStorage
     содержит флаг открытия книги (например, из других модулей). */
  if (name === "library" && mounted.has(name)) {
    checkPendingLibraryNav(document.getElementById("library-root"));
  }
}

function canRemount(name) {
  if (name === "library" && isLibraryBusy()) return false;
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
        unmountRoute(name);
        delete root.dataset.mounted;
        root.innerHTML = "";
      }
      mountRoute(name);
    }
    applyI18n(document);
  });
}

document.querySelectorAll(".sidebar-icon").forEach((btn) => {
  btn.addEventListener("click", () => showRoute(btn.dataset.route));
});

applyI18n(document);
setupLanguageToggle();
mountResilienceBar();
mountVersionBadge().catch((err) => {
  console.warn("[router] version badge mount failed:", err);
});

(async () => {
  let onboardingDone = false;
  try {
    const prefs = /** @type {any} */ (await window.api.preferences.getAll());
    onboardingDone = prefs?.onboardingDone === true;
  } catch { /* fresh start */ }

  const legacyDone = localStorage.getItem("bibliary_setup_done") === "1";
  if (legacyDone && !onboardingDone) {
    onboardingDone = true;
    try {
      await window.api.preferences.set({ onboardingDone: true, onboardingVersion: 1 });
      localStorage.removeItem("bibliary_setup_done");
    } catch { /* retry next launch */ }
  }

  showRoute("models");
  if (!onboardingDone) {
    openWelcomeWizard({ force: true });
  }
})();

if (typeof t !== "function") {
  console.warn("[router] i18n is not initialised");
}
