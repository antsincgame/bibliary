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
/** Если основной exe занят (Explorer / антивирус), кладём копию под другим именем. */
const destAlt = path.join(destDir, `${productName.replace(/\s+/g, "-")}-${version}-portable.exe`);

if (!fs.existsSync(src)) {
  console.error(`Portable не найден (ожидался ${portableName} в ${buildOutDir}). Сначала: npm run electron:build -- --win portable`);
  process.exit(1);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait: без зависимости от SharedArrayBuffer */
  }
}

/** Копирует exe через буфер + атомарный rename (обходит часть EBUSY на copyFile). */
function copyExeAtomic(src, destPath) {
  const buf = fs.readFileSync(src);
  const tmp = `${destPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, buf);
    if (fs.existsSync(destPath)) {
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* занят — rename упадёт, вызывающий код попробует другой путь */
      }
    }
    fs.renameSync(tmp, destPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function tryCopyTo(destPath, attempts = 12, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      copyExeAtomic(src, destPath);
      return destPath;
    } catch (e) {
      lastErr = e;
      const code = /** @type {NodeJS.ErrnoException} */ (e)?.code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        sleepSync(delayMs);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

fs.mkdirSync(destDir, { recursive: true });

let placed;
try {
  placed = tryCopyTo(dest);
} catch (primaryErr) {
  console.warn(`[copy-portable] не удалось записать ${path.relative(root, dest)}:`, primaryErr);
  console.warn(`[copy-portable] пробую альтернативу: ${path.relative(root, destAlt)}`);
  placed = tryCopyTo(destAlt);
}
console.log(`Portable скопирован: ${path.relative(root, placed)}`);

/* Remove the bare exe from buildOutDir so users don't accidentally launch
   the wrong copy (which has no data/ folder next to it). */
try {
  fs.unlinkSync(src);
  console.log(`Удалён голый exe: ${path.relative(root, src)}`);
} catch {
  /* EBUSY / permission — не критично, просто предупреждаем. */
  console.warn(`Не удалось удалить ${path.relative(root, src)} (возможно заблокирован).`);
}
