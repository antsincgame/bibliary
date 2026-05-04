"use strict";
/**
 * Генератор PNG-фикстур для vision_ocr дисциплин Олимпиады.
 *
 * Запускать вручную при добавлении новых тестов; вывод копируется
 * в `electron/lib/llm/arena/disciplines.ts` как base64-data URI.
 *
 * Usage:
 *   node scripts/generate-vision-ocr-fixtures.cjs
 *
 * Печатает в stdout JSON с {id, base64} парами для каждого fixture.
 */

const sharp = require("sharp");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Рендерит чёрный текст на белом PNG через SVG → sharp → PNG buffer.
 * Шрифт — DejaVu Sans (универсальный, читабельный, не требует системного).
 *
 * @param {{text: string, width: number, height: number, fontSize?: number}} opts
 * @returns {Promise<string>} base64 (без data:image/png;base64,)
 */
async function renderTextPng({ text, width, height, fontSize = 32 }) {
  /* SVG с чёрным текстом, центрированным на белом фоне.
   * font-family: sans-serif fallback chain — sharp+librsvg использует
   * fontconfig, что обычно подхватывает Arial/DejaVu. */
  const lines = text.split("\n");
  const lineHeight = Math.round(fontSize * 1.4);
  const totalHeight = lineHeight * lines.length;
  const startY = Math.round((height - totalHeight) / 2 + fontSize);
  const tspans = lines.map((line, i) =>
    `<tspan x="50%" y="${startY + i * lineHeight}" text-anchor="middle">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</tspan>`,
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="white"/>
  <text font-family="sans-serif" font-size="${fontSize}" fill="black" font-weight="500">${tspans}</text>
</svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return png.toString("base64");
}

const FIXTURES = [
  {
    id: "ocr_simple_print",
    text: "THE QUICK BROWN FOX",
    width: 480,
    height: 80,
    fontSize: 36,
    expectedTokens: ["the", "quick", "brown", "fox"],
  },
  {
    id: "ocr_two_lines",
    text: "Hello World\n2024-12-25",
    width: 360,
    height: 140,
    fontSize: 28,
    expectedTokens: ["hello", "world", "2024", "12", "25"],
  },
  {
    id: "ocr_numbers_dense",
    text: "INVOICE #4291\nTotal: $1,234.56",
    width: 480,
    height: 140,
    fontSize: 28,
    expectedTokens: ["invoice", "4291", "total", "1234", "56"],
  },
  {
    id: "ocr_blank_no_text",
    text: "",  /* пустая картинка — модель должна сказать NO_TEXT */
    width: 200,
    height: 100,
    fontSize: 1,
    expectedTokens: [],
  },
];

async function main() {
  const outDir = path.join(__dirname, "..", "electron", "lib", "llm", "arena", "fixtures");
  fs.mkdirSync(outDir, { recursive: true });
  const result = {};
  for (const f of FIXTURES) {
    const b64 = await renderTextPng(f);
    result[f.id] = {
      base64: b64,
      sizeBytes: Buffer.from(b64, "base64").length,
      expectedTokens: f.expectedTokens,
      width: f.width,
      height: f.height,
      text: f.text,
    };
    /* Также сохраняем PNG для визуальной верификации. */
    fs.writeFileSync(path.join(outDir, `${f.id}.png`), Buffer.from(b64, "base64"));
  }
  fs.writeFileSync(
    path.join(outDir, "vision-ocr-fixtures.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[generate-vision-ocr-fixtures] FAILED:", err);
  process.exit(1);
});
