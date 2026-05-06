#!/usr/bin/env node
/**
 * scripts/generate-icon.cjs
 *
 * Генерирует фирменную иконку Bibliary 1024x1024 PNG → build/icon.png.
 * Из этого PNG electron-builder при сборке автоматически создаст:
 *   - macOS: build/icon.icns (16/32/64/128/256/512/1024 px)
 *   - Windows: build/icon.ico (16/24/32/48/64/128/256 px)
 *   - Linux: использует исходный PNG
 *
 * Запуск:
 *   node scripts/generate-icon.cjs
 *
 * Стиль: /2666 HUD-эстетика проекта — моноширинный, кислотный акцент,
 * тёмный фон с микро-grid'ом, минимализм.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createCanvas } = require("@napi-rs/canvas");

const SIZE = 1024;
const ROOT = path.resolve(__dirname, "..");
const OUT_PNG = path.join(ROOT, "build", "icon.png");

const COLOR_BG_OUTER = "#0a0c0e";
const COLOR_BG_INNER = "#13171c";
const COLOR_GRID = "#1a1f26";
const COLOR_ACCENT = "#7af542";
const COLOR_ACCENT_DIM = "#3e7a22";

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawIcon(ctx, size) {
  /* Внешний радиус — стандартный squircle macOS получает electron-builder
     при создании .icns; нам важен только внешний rounded rect. */
  const radius = size * 0.22;

  /* 1. Тёмный фон со внутренним градиентом — глубина без визуального шума. */
  drawRoundedRect(ctx, 0, 0, size, size, radius);
  ctx.clip();
  const grad = ctx.createRadialGradient(size / 2, size * 0.4, size * 0.1, size / 2, size / 2, size * 0.7);
  grad.addColorStop(0, COLOR_BG_INNER);
  grad.addColorStop(1, COLOR_BG_OUTER);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  /* 2. Микро-grid: HUD-эстетика. Шаг 64px на 1024 = 16 линий. */
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  const step = size / 16;
  for (let i = 1; i < 16; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(size, i * step);
    ctx.stroke();
  }

  /* 3. Угловые скобки — HUD-рамка. */
  ctx.strokeStyle = COLOR_ACCENT_DIM;
  ctx.lineWidth = size * 0.012;
  const margin = size * 0.08;
  const armLen = size * 0.06;
  /* TL */
  ctx.beginPath();
  ctx.moveTo(margin, margin + armLen);
  ctx.lineTo(margin, margin);
  ctx.lineTo(margin + armLen, margin);
  ctx.stroke();
  /* TR */
  ctx.beginPath();
  ctx.moveTo(size - margin - armLen, margin);
  ctx.lineTo(size - margin, margin);
  ctx.lineTo(size - margin, margin + armLen);
  ctx.stroke();
  /* BL */
  ctx.beginPath();
  ctx.moveTo(margin, size - margin - armLen);
  ctx.lineTo(margin, size - margin);
  ctx.lineTo(margin + armLen, size - margin);
  ctx.stroke();
  /* BR */
  ctx.beginPath();
  ctx.moveTo(size - margin - armLen, size - margin);
  ctx.lineTo(size - margin, size - margin);
  ctx.lineTo(size - margin, size - margin - armLen);
  ctx.stroke();

  /* 4. Стопка книг — три прямоугольника с разной шириной, перспектива снизу.
     Bibliary = библиотека + структурированное знание. */
  const stackCenterX = size / 2;
  const stackBaseY = size * 0.74;
  const bookHeight = size * 0.075;
  const bookSpacing = size * 0.022;

  const books = [
    { w: size * 0.48, color: "#6b6d70", offset: 0 },
    { w: size * 0.42, color: "#909296", offset: -size * 0.015 },
    { w: size * 0.55, color: COLOR_ACCENT, offset: size * 0.005 },
  ];

  let y = stackBaseY;
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const x = stackCenterX - book.w / 2 + book.offset;
    /* Корешок книги — прямоугольник со скруглениями */
    ctx.fillStyle = book.color;
    drawRoundedRect(ctx, x, y - bookHeight, book.w, bookHeight, bookHeight * 0.15);
    ctx.fill();
    /* Тонкие линии "страниц" сверху книги */
    if (i < books.length - 1) {
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + bookHeight * 0.3, y - bookHeight * 0.2);
      ctx.lineTo(x + book.w - bookHeight * 0.3, y - bookHeight * 0.2);
      ctx.stroke();
    }
    y -= bookHeight + bookSpacing;
  }

  /* 5. Большая моноширинная "B" над стопкой — главный знак. */
  const fontSize = size * 0.42;
  ctx.fillStyle = COLOR_ACCENT;
  ctx.font = `bold ${fontSize}px "Iosevka", "JetBrains Mono", "Menlo", "Consolas", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("B", size / 2, size * 0.42);

  /* 6. Подпись внизу под книгами — крошечная моноширинная метка */
  ctx.fillStyle = COLOR_ACCENT_DIM;
  ctx.font = `${size * 0.04}px "Iosevka", "JetBrains Mono", "Menlo", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("BIBLIARY", size / 2, size * 0.92);
}

async function main() {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext("2d");
  drawIcon(ctx, SIZE);

  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(OUT_PNG, buffer);

  console.log(`[generate-icon] wrote ${OUT_PNG} (${SIZE}x${SIZE}, ${Math.round(buffer.byteLength / 1024)} KB)`);
  console.log("[generate-icon] electron-builder автоматически создаст .icns/.ico из этого PNG при сборке.");
}

main().catch((err) => {
  console.error("[generate-icon] Fatal:", err);
  process.exit(1);
});
