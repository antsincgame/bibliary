# Cross-platform statu Bibliary

> Документ ведётся вместе с roadmap 0.4.x. Обновляется при каждом релизе с
> добавленной/удалённой нативной зависимостью.

## Целевые платформы

| Платформа | Статус | Артефакт | Phase |
|---|---|---|---|
| Windows x64 | Production | NSIS installer + portable .exe | 0.x (готово) |
| Linux x64 | Beta (untested) | AppImage + .deb + .tar.gz | Phase 4 (готов код, нет CI-валидации артефактов) |
| macOS arm64 / x64 | **Отменено в 0.4.x** | — | — |
| Linux arm64 | Не планируется | — | — |

> **Решение от 2026-04-30:** macOS-ветка снята с roadmap 0.4.x, чтобы не
> распылять усилия. Linux x64 остался — код фундамента уже написан и не
> мешает Win-сборкам.

## Native dependencies

| Пакет | Win x64 | Linux x64 | macOS arm64 | macOS x64 | Способ доставки | Заметка |
|---|---|---|---|---|---|---|
| `better-sqlite3` ^12.9 | OK (rebuild) | OK | OK | OK | npm rebuild + `ensure-sqlite-abi.cjs` для DX | NODE_MODULE_VERSION 145 (Electron 41) ≠ 127 (Node 22). Phase 0 dual-stash снимает боль переключения. |
| `sharp` (libvips) | OK | OK | OK | OK | sharp prebuilds | На Win использует `vendor/sharp-libvips/<ver>/win32-x64/lib/`. На Linux/Mac — системный libvips или prebuild. См. [electron/lib/embedder/shared.ts](../electron/lib/embedder/shared.ts) строки 18-44. Phase 4.1 убирает win-specific path. |
| `@napi-rs/canvas` ^0.1 | OK | OK | OK | OK | napi-rs prebuilds | Не требует системного libcanvas. |
| `@napi-rs/system-ocr` ^1.0 | OK | **N/A** | OK | OK | napi-rs prebuilds | Win = `Windows.Media.Ocr`, macOS = Vision Framework, Linux = unsupported (см. `getOcrSupport()` в [electron/lib/scanner/ocr/index.ts](../electron/lib/scanner/ocr/index.ts)). UI должен скрывать OCR-toggle на Linux. Phase 4.3 — helper text про vision-LLM fallback. |
| `@firecrawl/pdf-inspector` ^1.8 | OK | OK | OK | OK | napi-rs prebuilds | Rust + lopdf. Primary стадия PDF-парсинга. |
| `edgeparse` ^0.2 | OK | OK | OK | OK | napi-rs prebuilds | Rust + XY-Cut++. Secondary стадия. addon map для всех платформ уже в [electron/lib/scanner/parsers/edgeparse-bridge.ts](../electron/lib/scanner/parsers/edgeparse-bridge.ts) строки 52-58. |
| `pdfjs-dist` ^4.10 | OK | OK | OK | OK | pure JS | Emergency fallback парсер. |
| `7zip-bin` ^5.2 | OK | OK | OK | OK | npm package с per-platform binaries | Cross-platform fallback в [electron/lib/library/archive-extractor.ts](../electron/lib/library/archive-extractor.ts) строки 137-145. |
| `7z-bin` ^0.0 | OK | OK | OK | OK | npm package | Альтернативный 7z, та же стратегия. |

## Vendored binaries (`vendor/`)

| Папка | Win x64 | Linux x64 | macOS arm64 | macOS x64 | План |
|---|---|---|---|---|---|
| `vendor/djvulibre/win32-x64/` | OK | — | — | — | Phase 4.1: `vendor/djvulibre/linux-x64/` через `apt-get install djvulibre-bin`. Phase 5.1: `vendor/djvulibre/darwin-{arm64,x64}/` через `brew install djvulibre`. |
| `vendor/7zip/win32-x64/` | OK | — | — | — | Phase 4.1: можно удалить, npm `7zip-bin` уже cross-platform fallback. |

## Платформо-зависимый код (текущие места)

| Файл | Hardcoded `win32-x64` / `process.platform === "win32"` | План фазы 4.2 |
|---|---|---|
| [electron/lib/embedder/shared.ts](../electron/lib/embedder/shared.ts) | sharp libvips path `vendor/<ver>/win32-x64/lib` | Win-only ветка `if (platform === "win32")`, на Linux/Mac пропустить |
| [electron/lib/scanner/parsers/djvu-cli.ts](../electron/lib/scanner/parsers/djvu-cli.ts) | `vendor/djvulibre/win32-x64` пути | `platformVendorDir()` helper + `exeName()` для расширения .exe |
| [electron/lib/library/marker-sidecar.ts](../electron/lib/library/marker-sidecar.ts) | `vendor/djvulibre/win32-x64/ddjvu.exe` | то же |
| [electron/lib/library/archive-extractor.ts](../electron/lib/library/archive-extractor.ts) | `vendor/7zip/win32-x64/7z.exe` (с npm fallback) | `platformVendorDir()` + полагаемся на `7zip-bin` для Linux/Mac |
| [electron/main.ts](../electron/main.ts) | `process.platform === "win32"` для sandbox check | Без изменений — корректно ветвится |
| [electron-builder.yml](../electron-builder.yml) | только `win:` секция, `extraResources from: vendor/.../win32-x64` | Phase 4.4 + 5.2: добавить `linux:` и `mac:` секции, использовать `${platform}-${arch}` подстановки |

## SQLite ABI cycle (Phase 0)

```
                          ┌─────────────────────────────────┐
                          │ .electron-rebuild-stash/        │
                          │  better_sqlite3.electron.node   │
                          │  better_sqlite3.node.node       │
                          │  better_sqlite3.node (legacy)   │
                          └────────────┬────────────────────┘
                                       │ select
                                       ▼
node_modules/better-sqlite3/build/Release/better_sqlite3.node
                                       │
                          ┌────────────┴────────────────────┐
                          │ better_sqlite3.node.abi-marker │
                          │  ←── "node" or "electron"      │
                          └─────────────────────────────────┘
```

`scripts/ensure-sqlite-abi.cjs --target=node|electron` управляет циклом. См.
комментарии в самом файле: select из stash, fallback на rebuild, авто-stash
после rebuild, idempotent через marker-файл.

## Что блокирует кросс-платформенность сегодня (топ-блокеры)

### Linux x64
1. **vendor/djvulibre/linux-x64/** не существует — DJVU импорт упадёт. Phase 4.1.
2. **electron-builder.yml** не имеет `linux:` секции — нет AppImage цели. Phase 4.4.
3. **Hardcoded `win32-x64`** в trёх файлах сканера — DJVU/sharp ищут в win32 папке. Phase 4.2.
4. **OCR не работает на Linux** — UI должен это явно показывать. Phase 4.3.
5. **`scripts/build-portable.js`** хардкодит `--win portable` — не собрать AppImage. Phase 4.6.

### macOS (arm64 + x64) — отменено в 0.4.x
Решение от 2026-04-30. Если потребуется в будущем (0.5.x+):
1. Восстановить `scripts/download-djvulibre-macos.cjs` (есть в git history до коммита `audit: cancel macOS roadmap`).
2. Вернуть `mac:` секцию в `electron-builder.yml` (DMG arm64+x64).
3. `release-macos.yml` CI с runner `macos-latest`.
4. Codesigning: ad-hoc или Apple Developer ID + notarisation.

## SQLite — альтернативы (для Phase 6 если потребуется)

| Вариант | API | LOC миграции | Риск | Плюсы | Минусы |
|---|---|---|---|---|---|
| A) **dual-stash** (Phase 0) | sync (better-sqlite3 12) | ~80 | low | мгновенное переключение | требует `npm rebuild` хотя бы один раз для каждой ABI |
| B) **@vscode/sqlite3** | async | ~500-900 | medium | prebuilds для всех платформ + ABI | надо переписать все callers на async |
| C) **sql.js** (WASM) | sync (in-memory) | ~800-2000 | high | zero ABI, любая платформа | manual persist, медленнее на FTS5 |
| D) **детект ABI + rebuild** | sync | ~40 | low | мало изменений | не убирает время rebuild |
| E) **sidecar SQLite-сервер** | TCP IPC | ~1500-4000 | very high | полная изоляция | архитектурная сложность, новый процесс |

Текущий выбор: A (Phase 0). Если в Phase 0-5 окажется что dual-stash не
снимает боль — рассмотреть B в Phase 6.
