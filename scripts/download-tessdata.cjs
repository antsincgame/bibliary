#!/usr/bin/env node
/**
 * Скачать tessdata для Tesseract.js (Tier-1a OCR).
 *
 * Mirror: tesseract-ocr/tessdata_fast (smaller, faster, ~3-5MB per language).
 * Альтернатива — tessdata_best (~22MB per language, лучшее качество). Выбран
 * fast как baseline; пользователь может вручную заменить файлы на best и
 * tesseract.js это подхватит.
 *
 * Запускается:
 *   - вручную: `npm run setup:tessdata`
 *   - автоматически из postinstall.cjs (если файлы отсутствуют)
 *
 * Если файлы уже на диске — skip. Idempotent.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const TESSDATA_DIR = path.join(ROOT, "vendor", "tessdata");
const URL_BASE = "https://github.com/tesseract-ocr/tessdata_fast/raw/main";
/* Focus on three language families: Cyrillic (rus, ukr), Chinese
 * (chi_sim simplified, chi_tra traditional), English. tessdata_fast
 * ~3-5MB each — total ~25MB. Phase 13b decision: keep CPU-only, no
 * PaddleOCR or Python sidecar. */
const LANGUAGES = ["rus", "ukr", "eng", "chi_sim", "chi_tra"];

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let cleanup = () => {};

    const handler = (res, depth = 0) => {
      if (depth > 5) {
        cleanup();
        return reject(new Error("too many redirects"));
      }
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
        const next = res.headers.location;
        if (!next) {
          cleanup();
          return reject(new Error(`redirect without location (HTTP ${res.statusCode})`));
        }
        res.resume();
        https.get(next, (r2) => handler(r2, depth + 1)).on("error", (err) => {
          cleanup();
          reject(err);
        });
        return;
      }
      if (res.statusCode !== 200) {
        cleanup();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close((err) => err ? reject(err) : resolve());
      });
      file.on("error", (err) => {
        cleanup();
        reject(err);
      });
    };

    cleanup = () => {
      try { file.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    };

    https.get(url, handler).on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

async function main() {
  fs.mkdirSync(TESSDATA_DIR, { recursive: true });

  for (const lang of LANGUAGES) {
    const fileName = `${lang}.traineddata`;
    const destPath = path.join(TESSDATA_DIR, fileName);

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100_000) {
      console.log(`[tessdata] ${fileName} OK (${(fs.statSync(destPath).size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    const url = `${URL_BASE}/${fileName}`;
    process.stdout.write(`[tessdata] downloading ${fileName} from tesseract-ocr/tessdata_fast... `);
    try {
      await downloadFile(url, destPath);
      const size = fs.statSync(destPath).size;
      if (size < 100_000) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        throw new Error(`downloaded file suspiciously small (${size} bytes)`);
      }
      console.log(`OK (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(`\n[tessdata] FAILED to download ${fileName}: ${err.message}`);
      console.error(`[tessdata] manual fallback: download from ${url} into ${TESSDATA_DIR}/`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(`[tessdata] unhandled error: ${err.message}`);
  process.exit(1);
});
