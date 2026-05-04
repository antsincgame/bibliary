import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dir = path.join(__dirname, "..", "dist-electron");
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}\n');

const defaultsSrc = path.join(__dirname, "..", "electron", "defaults");
const defaultsDst = path.join(dir, "defaults");
if (fs.existsSync(defaultsSrc)) {
  copyTree(defaultsSrc, defaultsDst);
}

/* tsc не копирует *.json вместе с *.ts (resolveJsonModule только тип),
 * поэтому fixture-файлы копируем вручную, чтобы prod-сборка имела
 * доступ к base64 PNG для vision_ocr дисциплин (см. fixtures/). */
copyJsonAssets(path.join(__dirname, "..", "electron"), dir);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function copyJsonAssets(srcRoot, dstRoot) {
  const queue = [srcRoot];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const from = path.join(cur, entry.name);
      const rel = path.relative(srcRoot, from);
      if (entry.isDirectory()) {
        queue.push(from);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const to = path.join(dstRoot, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}
