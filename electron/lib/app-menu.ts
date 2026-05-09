/**
 * Application menu — кроссплатформенный шаблон.
 *
 * macOS:  [App] [File] [Edit] [View] [Window] [Help]
 * Win/Linux: [File] [Edit] [View] [Window] [Help]
 *
 * App menu (только macOS) добавляется первым: About / Hide / Quit — конвенция Apple.
 * Все акселераторы — `CmdOrCtrl+...`, Electron сам мапит на ⌘ на macOS и Ctrl на Win/Linux.
 */

import { Menu, app, shell, BrowserWindow, dialog } from "electron";
import type { MenuItemConstructorOptions } from "electron";

const APP_NAME = "Bibliary";

/**
 * Win/Linux: без мнемоник (&) Chromium часто трактует одиночный Alt как
 * «меню» и перехватывает клавишу до системного Alt+Shift / Alt+Ctrl
 * переключения раскладки (Electron #17418, #28088; обход как в nativefier#768).
 * На macOS символ `&` в подписях не используется — оставляем обычный текст.
 */
function topBarLabel(isMac: boolean, plain: string, winLinuxMnemonic: string): string {
  return isMac ? plain : winLinuxMnemonic;
}

function buildMacAppMenu(): MenuItemConstructorOptions {
  return {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `About ${APP_NAME}` },
      { type: "separator" },
      {
        label: "Preferences…",
        accelerator: "Cmd+,",
        click: (_item, win) => focusRouteInWindow(win as BrowserWindow | undefined, "settings"),
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide", label: `Hide ${APP_NAME}` },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit", label: `Quit ${APP_NAME}` },
    ],
  };
}

function buildFileMenu(isMac: boolean): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [
    {
      label: "Open Library Folder…",
      accelerator: "CmdOrCtrl+O",
      click: (_item, win) => focusRouteInWindow(win as BrowserWindow | undefined, "library"),
    },
    {
      label: "New Dataset",
      accelerator: "CmdOrCtrl+N",
      click: (_item, win) => focusRouteInWindow(win as BrowserWindow | undefined, "datasets"),
    },
    { type: "separator" },
    isMac ? { role: "close" } : { role: "quit" },
  ];
  return { label: topBarLabel(isMac, "File", "&File"), submenu };
}

function buildEditMenu(isMac: boolean): MenuItemConstructorOptions {
  const base: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
  ];
  if (isMac) {
    base.push(
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Speech",
        submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
      },
    );
  } else {
    base.push({ role: "delete" }, { type: "separator" }, { role: "selectAll" });
  }
  return { label: topBarLabel(isMac, "Edit", "&Edit"), submenu: base };
}

function buildViewMenu(isMac: boolean): MenuItemConstructorOptions {
  return {
    label: topBarLabel(isMac, "View", "&View"),
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

function buildWindowMenu(isMac: boolean): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [{ role: "minimize" }, { role: "zoom" }];
  if (isMac) {
    submenu.push(
      { type: "separator" },
      { role: "front" },
      { type: "separator" },
      { role: "window" },
    );
  } else {
    submenu.push({ role: "close" });
  }
  return { label: topBarLabel(isMac, "Window", "&Window"), submenu };
}

function buildHelpMenu(isMac: boolean): MenuItemConstructorOptions {
  return {
    role: "help",
    ...(!isMac ? { label: "&Help" } : {}),
    submenu: [
      {
        label: "Documentation",
        click: async () => {
          await shell.openExternal("https://github.com/antsincgame/bibliary");
        },
      },
      {
        label: "Report an Issue",
        click: async () => {
          await shell.openExternal("https://github.com/antsincgame/bibliary/issues");
        },
      },
      { type: "separator" },
      {
        label: `About ${APP_NAME}`,
        click: showAboutDialog,
      },
    ],
  };
}

function showAboutDialog(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
  void dialog.showMessageBox(win as BrowserWindow, {
    type: "info",
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `Version ${app.getVersion()}`,
      "",
      "Local book library → structured Markdown → embedded LanceDB vector collections → ChatML JSONL fine-tuning datasets.",
      "",
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      `Chromium ${process.versions.chrome}`,
      `Platform ${process.platform}-${process.arch}`,
    ].join("\n"),
    buttons: ["OK"],
  });
}

/**
 * Если окно открыто, переключает SPA-route на указанный (отправляя сигнал
 * в renderer через webContents.send). На стороне renderer слушатель
 * переключает sidebar. Если окна нет — no-op.
 */
function focusRouteInWindow(win: BrowserWindow | undefined, route: string): void {
  const target = win ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!target) return;
  target.webContents.send("app-menu:navigate", route);
  if (target.isMinimized()) target.restore();
  target.focus();
}

export function buildApplicationMenu(): Menu {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) template.push(buildMacAppMenu());
  template.push(
    buildFileMenu(isMac),
    buildEditMenu(isMac),
    buildViewMenu(isMac),
    buildWindowMenu(isMac),
    buildHelpMenu(isMac),
  );
  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}
