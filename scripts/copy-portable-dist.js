import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const ebPath = path.join(root, "electron-builder.yml");
const eb = fs.existsSync(ebPath) ? fs.readFileSync(ebPath, "utf8") : "";
const productMatch = eb.match(/^\s*productName:\s*(.+?)\s*$/m);
const productName = productMatch ? productMatch[1].replace(/^["']|["']$/g, "").trim() : pkg.name;
const version = pkg.version;
const portableName = `${productName} ${version}.exe`;

/* Output dir такой же как в electron-builder.yml: ENV → fallback "release". */
const buildOutDir = process.env.BIBLIARY_BUILD_OUT
  ? path.isAbsolute(process.env.BIBLIARY_BUILD_OUT)
    ? process.env.BIBLIARY_BUILD_OUT
    : path.join(root, process.env.BIBLIARY_BUILD_OUT)
  : path.join(root, "release");

const src = path.join(buildOutDir, portableName);
/* Конечный artifact всегда копируем в release/dist-portable (вне зависимости от build out),
 * чтобы git-ignore не сбивался и distribution был в одном месте. */
const destDir = path.join(root, "release", "dist-portable");
const dest = path.join(destDir, portableName);

if (!fs.existsSync(src)) {
  console.error(`Portable не найден (ожидался ${portableName} в ${buildOutDir}). Сначала: npm run electron:build -- --win portable`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Portable скопирован: ${path.relative(root, dest)}`);

/* Remove the bare exe from buildOutDir so users don't accidentally launch
   the wrong copy (which has no data/ folder next to it). */
try {
  fs.unlinkSync(src);
  console.log(`Удалён голый exe: ${path.relative(root, src)}`);
} catch {
  /* EBUSY / permission — не критично, просто предупреждаем. */
  console.warn(`Не удалось удалить ${path.relative(root, src)} (возможно заблокирован).`);
}
