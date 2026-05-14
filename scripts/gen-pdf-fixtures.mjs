/**
 * Generates the Cyrillic / CJK PDF fixtures for the golden corpus.
 *
 * Why generated, not downloaded: the dev sandbox blocks outbound file
 * downloads, and committing real book/paper PDFs raises copyright + size
 * concerns anyway. These fixtures are *built* from public-domain text
 * (19th-c. Russian classics; classical Chinese; Meiji-era Japanese) plus
 * a short article-style block, with pdf-lib + system Unicode fonts —
 * reproducible, copyright-free, real born-digital text layers that
 * exercise pdf.ts extraction across Cyrillic, Han and kana.
 *
 *   node scripts/gen-pdf-fixtures.mjs
 *
 * Output: tests/golden-corpus/fixtures/{10-ru,11-zh,12-ja}-classic.pdf
 * Requires @pdf-lib/fontkit (devDependency) + system fonts.
 */
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(process.cwd(), "tests", "golden-corpus", "fixtures");

const IPA_GOTHIC = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf";
const WQY_ZENHEI = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";

/**
 * Extract font #index of a TrueType Collection (.ttc) as standalone .ttf
 * bytes. pdf-lib / @pdf-lib/fontkit can parse a .ttc but cannot lay out
 * text with it (`font.layout is not a function`), so the single font has
 * to be rebuilt as its own sfnt.
 */
function extractTtcFont(ttc, index = 0) {
  if (ttc.toString("latin1", 0, 4) !== "ttcf") throw new Error("not a .ttc");
  const numFonts = ttc.readUInt32BE(8);
  if (index >= numFonts) throw new Error(`.ttc has only ${numFonts} font(s)`);
  const dir = ttc.readUInt32BE(12 + index * 4);
  const sfntVersion = ttc.readUInt32BE(dir);
  const numTables = ttc.readUInt16BE(dir + 4);
  const recs = [];
  for (let i = 0; i < numTables; i++) {
    const o = dir + 12 + i * 16;
    recs.push({
      tag: ttc.subarray(o, o + 4),
      checksum: ttc.readUInt32BE(o + 4),
      offset: ttc.readUInt32BE(o + 8),
      length: ttc.readUInt32BE(o + 12),
    });
  }
  const aligned = (n) => (n + 3) & ~3;
  const headerSize = 12 + 16 * numTables;
  const out = Buffer.alloc(headerSize + recs.reduce((s, r) => s + aligned(r.length), 0));
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  const es = Math.floor(Math.log2(numTables));
  const sr = 16 * 2 ** es;
  out.writeUInt16BE(sr, 6);
  out.writeUInt16BE(es, 8);
  out.writeUInt16BE(numTables * 16 - sr, 10);
  let pos = headerSize;
  for (let i = 0; i < numTables; i++) {
    const r = recs[i];
    const ro = 12 + i * 16;
    r.tag.copy(out, ro);
    out.writeUInt32BE(r.checksum, ro + 4);
    out.writeUInt32BE(pos, ro + 8);
    out.writeUInt32BE(r.length, ro + 12);
    ttc.copy(out, pos, r.offset, r.offset + r.length);
    /* head.checkSumAdjustment is whole-file scoped — stale after the
       rebuild; zero it so strict parsers don't reject the font. */
    if (r.tag.toString("latin1") === "head") out.writeUInt32BE(0, pos + 8);
    pos += aligned(r.length);
  }
  return out;
}

/* Public domain — Tolstoy (1877), Pushkin (1829), Dostoevsky (1866). */
const RU_LINES = [
  "Русская классика — тестовая фикстура",
  "",
  "Лев Николаевич Толстой. Анна Каренина.",
  "Все счастливые семьи похожи друг на друга, каждая",
  "несчастливая семья несчастлива по-своему. Всё смешалось",
  "в доме Облонских. Жена узнала, что муж был в связи",
  "с бывшею в их доме француженкою-гувернанткой.",
  "",
  "Александр Сергеевич Пушкин. Зимнее утро.",
  "Мороз и солнце; день чудесный! Ещё ты дремлешь,",
  "друг прелестный — пора, красавица, проснись.",
  "",
  "Фёдор Михайлович Достоевский. Преступление и наказание.",
  "В начале июля, в чрезвычайно жаркое время, под вечер,",
  "один молодой человек вышел из своей каморки.",
  "",
  "Научная статья. Извлечение текста из PDF.",
  "Аннотация. В работе проверяется извлечение текстового",
  "слоя из born-digital PDF для кириллицы и письменностей CJK.",
  "1. Введение. 2. Метод. 3. Результаты. 4. Заключение.",
  "Литература: [1] Толстой Л. Н., 1877. [2] Пушкин А. С., 1829.",
];

/* Public domain — Laozi, Li Bai, Du Fu, Confucius (all ancient). */
const ZH_LINES = [
  "中文经典 — 测试文件",
  "",
  "老子 — 道德經 第一章",
  "道可道，非常道。名可名，非常名。",
  "無名天地之始；有名萬物之母。玄之又玄，眾妙之門。",
  "",
  "李白 — 靜夜思",
  "床前明月光，疑是地上霜。舉頭望明月，低頭思故鄉。",
  "",
  "杜甫 — 春望",
  "國破山河在，城春草木深。感時花濺淚，恨別鳥驚心。",
  "",
  "孔子 — 論語 學而第一",
  "學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？",
  "",
  "学术论文 — 从 PDF 中提取文本",
  "摘要：本文检验从原生数字 PDF 中提取文本层，",
  "涵盖西里尔字母与中日韩文字。",
  "一、引言。二、方法。三、结果。四、结论。",
  "参考文献：[1] 老子《道德经》。[2] 李白《静夜思》。",
];

/* Public domain — Bashō (17th c.), Natsume Sōseki (1905). */
const JA_LINES = [
  "日本語の古典 — テストフィクスチャ",
  "",
  "松尾芭蕉 — 俳句",
  "古池や 蛙飛び込む 水の音",
  "夏草や 兵どもが 夢の跡",
  "閑さや 岩にしみ入る 蝉の声",
  "",
  "夏目漱石 — 吾輩は猫である",
  "吾輩は猫である。名前はまだ無い。",
  "どこで生れたかとんと見当がつかぬ。",
  "何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。",
  "",
  "学術論文 — PDF からのテキスト抽出",
  "要旨：本稿はボーンデジタル PDF のテキスト層抽出を、",
  "キリル文字および漢字・仮名について検証する。",
  "一、序論。二、方法。三、結果。四、結論。",
  "参考文献：[1] 松尾芭蕉。[2] 夏目漱石、1905年。",
];

/** Fail loudly if the font lacks a glyph — never silently drop a character. */
function assertGlyphCoverage(fontBytes, lines, label) {
  const fk = fontkit.create(fontBytes);
  const probe = fk.fonts ? fk.fonts[0] : fk;
  const missing = new Set();
  for (const line of lines) {
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (cp > 0x20 && !probe.hasGlyphForCodePoint(cp)) missing.add(ch);
    }
  }
  if (missing.size > 0) {
    throw new Error(`${label}: font lacks glyphs for: ${[...missing].join(" ")}`);
  }
}

async function makePdf(fontBytes, lines, title) {
  assertGlyphCoverage(fontBytes, lines, title);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.setTitle(title);

  const pageW = 595;
  const pageH = 842;
  const margin = 56;
  const size = 13;
  const lineH = 26;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;
  for (const line of lines) {
    if (y < margin) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
    }
    if (line) page.drawText(line, { x: margin, y, size, font });
    y -= lineH;
  }
  return doc.save();
}

for (const f of [IPA_GOTHIC, WQY_ZENHEI]) {
  if (!existsSync(f)) {
    console.error(`Required system font not found: ${f}`);
    process.exit(1);
  }
}

const ipa = readFileSync(IPA_GOTHIC);
const wqy = extractTtcFont(readFileSync(WQY_ZENHEI), 0);

const jobs = [
  ["10-ru-classic.pdf", ipa, RU_LINES, "Russian classics - golden corpus fixture"],
  ["11-zh-classic.pdf", wqy, ZH_LINES, "Chinese classics - golden corpus fixture"],
  ["12-ja-classic.pdf", ipa, JA_LINES, "Japanese text - golden corpus fixture"],
];

for (const [name, fontBytes, lines, title] of jobs) {
  const pdf = await makePdf(fontBytes, lines, title);
  writeFileSync(join(FIXTURES, name), pdf);
  console.log(`  ${name}  ${pdf.length} bytes`);
}
console.log("Done.");
