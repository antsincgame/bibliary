import { mountModels, unmountModels } from "./models/models-page.js";
import { mountLibrary, isLibraryBusy, unmountLibrary, checkPendingLibraryNav } from "./library.js";
import { mountDatasets } from "./datasets.js";
import { mountSettings } from "./settings.js";
import { mountAdmin } from "./admin.js";
import { applyI18n, getLocale, setLocale, listLocales, onLocaleChange, t } from "./i18n.js";
import { mountResilienceBar } from "./components/resilience-bar.js";
import { openWelcomeWizard } from "./components/welcome-wizard.js";
import { mountVersionBadge } from "./components/version-badge.js";
import { mountAuthPage } from "./auth/auth-pages.js";

const ROUTES = ["models", "library", "datasets", "settings", "admin"];
const REMOUNT_ON_LOCALE = new Set([
  "library",
  "datasets",
  "models",
  "settings",
  "admin",
]);
const mounted = new Set();

function mountRoute(name) {
  if (name === "library") mountLibrary(document.getElementById("library-root"));
  else if (name === "datasets") mountDatasets(document.getElementById("datasets-root"));
  else if (name === "models") mountModels(document.getElementById("models-root"));
  else if (name === "settings") mountSettings(document.getElementById("settings-root"));
  else if (name === "admin") mountAdmin(document.getElementById("admin-root"));
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

/* Application menu (electron Menu) → SPA navigation. На macOS пользователь
   нажимает в меню File → Open Library Folder и попадает на route "library". */
if (typeof window.api?.appMenu?.onNavigate === "function") {
  window.api.appMenu.onNavigate((route) => showRoute(route));
}

applyI18n(document);
setupLanguageToggle();
mountResilienceBar();
mountVersionBadge().catch((err) => {
  console.warn("[router] version badge mount failed:", err);
});

/**
 * Web-mode auth gate: window.api.auth.meOrNull() возвращает null когда
 * пользователь не авторизован — показываем login/register экран до
 * первой успешной auth, потом обычный flow.
 *
 * Electron-mode preload.ts не выставляет api.auth — там single-user
 * без login, auth gate просто пропускается.
 */
async function requireAuth() {
  const auth = /** @type {any} */ (window).api?.auth;
  if (!auth || typeof auth.meOrNull !== "function") {
    return; /* Electron preload — без gate. */
  }
  const current = await auth.meOrNull();
  if (current) {
    revealAdminUiIfAdmin(current);
    return;
  }
  const authRoot = ensureAuthRoot();
  document.querySelectorAll(".route").forEach((el) => el.classList.remove("route-active"));
  document.querySelector(".sidebar")?.setAttribute("hidden", "true");
  authRoot.classList.add("route-active");
  await mountAuthPage(authRoot);
  authRoot.classList.remove("route-active");
  document.querySelector(".sidebar")?.removeAttribute("hidden");
  /* After auth completes meOrNull has the role; re-check. */
  try {
    const after = await auth.meOrNull();
    if (after) revealAdminUiIfAdmin(after);
  } catch { /* tolerate */ }
}

/** Phase 11d — reveal the admin sidebar icon only for users with role==="admin". */
function revealAdminUiIfAdmin(user) {
  if (user && user.role === "admin") {
    document.getElementById("sidebar-admin")?.removeAttribute("hidden");
  } else {
    document.getElementById("sidebar-admin")?.setAttribute("hidden", "true");
  }
}

function ensureAuthRoot() {
  let root = document.getElementById("route-auth");
  if (root) return root;
  root = document.createElement("section");
  root.id = "route-auth";
  root.className = "route route-auth";
  document.querySelector("main")?.appendChild(root) ?? document.body.appendChild(root);
  return root;
}

(async () => {
  await requireAuth();

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
