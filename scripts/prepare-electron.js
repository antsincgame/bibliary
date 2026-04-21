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

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}
