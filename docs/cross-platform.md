# Cross-platform status — Bibliary

> Документ ведётся вместе с release-планом. Обновляется при каждом релизе с
> добавленной/удалённой нативной зависимостью.

## Целевые платформы

| Платформа | Статус | Артефакт |
|---|---|---|
| Windows x64 | Production | NSIS installer + portable .exe |
| macOS arm64 | Production | DMG + ZIP |
| macOS x64 (Intel) | Production | DMG + ZIP (через универсальный билд) |
| Windows arm64 | Не планируется | — |

> **Решение (2026-05):** Linux/AppImage support удалён из roadmap.
> Мы фокусируемся на Windows + macOS — две платформы где у целевой
> аудитории (researchers + developers) есть LM Studio + достаточно VRAM.
> Linux пользователи могут запускать через Electron dev-режим из исходников
> (`npm run electron:dev`) на свой страх и риск, но официальных портаблов нет.

## Native deps inventory

| Пакет | Win x64 | macOS arm64 | macOS x64 | Способ доставки |
|---|---|---|---|---|
| `better-sqlite3` ^12 | OK | OK | OK | electron-rebuild + prebuild-install fallback |
| `sharp` (libvips) | OK | OK | OK | sharp prebuilds via npm (lazy-loaded) |
| `@firecrawl/pdf-inspector` ^1.8 | OK | OK | OK | napi-rs prebuilds |
| `@napi-rs/system-ocr` ^1.0 | OK | OK | OK | Win = Windows.Media.Ocr, macOS = Vision Framework |
| `@napi-rs/canvas` ^0.1 | OK | OK | OK | napi-rs prebuilds |
| `edgeparse` (.node addon) | OK (msvc) | OK (darwin-arm64 + darwin-x64) | OK | напрямую из npm package, отдельный postinstall |

Все native deps пробрасываются через `electron-builder.yml` `asarUnpack` —
они должны быть выгружены из `app.asar` чтобы native loader мог их найти
во время запуска.

## OCR matrix (DJVU + scanned PDFs)

| Платформа | System OCR | Vision-LLM (LM Studio) | Multi-lang strategy |
|---|---|---|---|
| Windows | Windows.Media.Ocr (single-language) | OK | Cycling per-page (язык за языком до first ≥30 chars) |
| macOS | Vision Framework (multi-language native) | OK | Single call со всеми языками одновременно |

Реализация в `electron/lib/scanner/parsers/djvu.ts:ocrDjvuPages` — выбирает
strategy через `os.platform()`. На macOS Vision Framework нативно поддерживает
50+ языков (включая ru/uk) без отдельной установки. На Windows нужны
language packs в Settings → Time & Language → Language.

## Vendor binaries (DjVuLibre + 7zip)

| Папка | Способ установки | Auto-fallback |
|---|---|---|
| `vendor/djvulibre/win32-x64/` | Закоммичено в репо | Pure-JS djvu.js (`vendor/djvu/djvu.js`) |
| `vendor/djvulibre/darwin-{arm64,x64}/` | `npm run setup:djvulibre-macos` копирует из `/opt/homebrew/bin` или `/usr/local/bin`; `brew install djvulibre` если нет | Pure-JS djvu.js |
| `vendor/7zip/win32-x64/` | Закоммичено в репо | 7zip-bin npm |
| `vendor/7zip/darwin-{arm64,x64}/` | `npm run setup:7zip-macos` через brew | 7zip-bin npm |

Vendor binaries нужны для production-билдов. В dev-режиме можно полагаться
на системные через PATH (если установлены через brew на macOS, или vendor/
закоммиченные на Windows).

## Build entrypoints

```bash
# Windows portable (.exe)
npm run electron:build-portable

# macOS arm64 + x64 (.dmg + .zip)
npm run electron:build-mac

# Multi-platform release (CI на 2 runner'ах: windows-latest + macos-latest)
git tag v1.X.Y && git push --tags
```

CI workflow `.github/workflows/release-portable.yml` собирает оба портабла
параллельно, затем `publish-release` job агрегирует артефакты в GitHub Release.

## Дополнительные настройки на платформе

### Windows (Win10/11)
1. Settings → Time & Language → Language → Add «Русский» и «Українська»
   (нужны language packs для Win.Media.Ocr)
2. LM Studio (опционально) — для vision-LLM fallback на сложных DJVU

### macOS (12+)
1. Vision Framework работает из коробки — никакой настройки не нужно
2. `brew install djvulibre p7zip` — если хочешь vendor binaries в production
   билде (build-script сам это делает при первом запуске)
3. LM Studio (опционально) — для vision-LLM fallback

## Что НЕ делаем cross-platform-универсально

- **OCR provider abstraction** — намеренно оставлено per-platform.
  Win.Media.Ocr и Vision Framework имеют разные capabilities (single vs
  multi-language), и абстракция скрыла бы важные различия.
- **Universal binary** — на macOS используем universal билд (electron-builder
  `--universal`). На Windows — только x64.
- **Code-signing** — оба платформа требуют отдельной настройки секретов
  (CSC_LINK для mac, отсутствует для Win — пользователь увидит warning при
  первом запуске).
