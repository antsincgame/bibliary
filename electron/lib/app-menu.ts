/**
 * Application menu — Windows/Linux шаблон.
 *
 * Layout: [File] [Edit] [View] [Window] [Help]
 *
 * Win/Linux: без мнемоник (&) Chromium часто трактует одиночный Alt как
 * «меню» и перехватывает клавишу до системного Alt+Shift / Alt+Ctrl
 * переключения раскладки (Electron #17418, #28088; обход как в nativefier#768).
 */

import { Menu, app, shell, BrowserWindow, dialog } from "electron";
import type { MenuItemConstructorOptions } from "electron";

const APP_NAME = "Bibliary";

function buildFileMenu(): MenuItemConstructorOptions {
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
    { role: "quit" },
  ];
  return { label: "&File", submenu };
}

function buildEditMenu(): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "delete" },
    { type: "separator" },
    { role: "selectAll" },
  ];
  return { label: "&Edit", submenu };
}

function buildViewMenu(): MenuItemConstructorOptions {
  return {
    label: "&View",
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

function buildWindowMenu(): MenuItemConstructorOptions {
  return {
    label: "&Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
  };
}

function buildHelpMenu(): MenuItemConstructorOptions {
  return {
    role: "help",
    label: "&Help",
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
  const template: MenuItemConstructorOptions[] = [
    buildFileMenu(),
    buildEditMenu(),
    buildViewMenu(),
    buildWindowMenu(),
    buildHelpMenu(),
  ];
  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(buildApplicationMenu());
}
