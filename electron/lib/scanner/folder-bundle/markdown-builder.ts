/**
 * Folder-Bundle Markdown Builder.
 *
 * Берёт `BookBundle` + результат парсинга основной книги + (опционально)
 * описания sidecars (vision-LLM для изображений, snippet для кода) и собирает
 * единый markdown-файл, готовый для chunking + RAG.
 *
 * Принципы:
 *  - Стабильность: один и тот же вход → один и тот же выход. Никаких таймстампов
 *    в теле, без нумерации, зависящей от mtime.
 *  - Заголовки секций — H1/H2/H3, чтобы chunker корректно отрезал по структуре.
 *  - Изображения вставляются как `![alt](rel/path)` + блок описания снизу.
 *  - Код вставляется в fenced code blocks с указанием языка по расширению.
 *  - Скачанные сайты оборачиваются как «Companion site» с титульной страницей
 *    (если index.html есть), без раскрытия HTML целиком.
 *
 * Этот слой НЕ вызывает LLM. Описания sidecars приходят извне (см. опции).
 */

import * as path from "path";
import type { ClassifiedFile, BookBundle } from "./classifier.js";

export interface SidecarDescription {
  /** Абсолютный путь файла (для матчинга с classifier output). */
  absPath: string;
  /** Краткое (1-3 предложения) описание для md и RAG. */
  description: string;
  /** Опциональный заголовок (если описатель смог его извлечь). */
  title?: string;
  /** Опциональный полный текст (например, для OCR изображения или snippet кода). */
  fullText?: string;
}

export interface BundleMarkdownInput {
  bundle: BookBundle;
  /** Тело основной книги в markdown. Если книги нет — пустая строка. */
  bookMarkdown: string;
  /** Title основной книги (метаданные). */
  bookTitle?: string;
  /** Author. */
  bookAuthor?: string;
  /** Описания sidecars: ключ — absPath. */
  descriptions?: Map<string, SidecarDescription>;
}

const CODE_LANG_BY_EXT: Record<string, string> = {
  py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", go: "go",
  rs: "rust", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", sh: "bash", bash: "bash", lua: "lua",
  scala: "scala", ex: "elixir", exs: "elixir", ml: "ocaml", fs: "fsharp",
  sql: "sql", r: "r", jl: "julia", ipynb: "json",
};

function langFor(file: ClassifiedFile): string {
  return CODE_LANG_BY_EXT[file.ext] ?? "";
}

function escapeMdInlinePath(p: string): string {
  /* для md-ссылок не экранируем путь полностью, но ()[] могут конфликтовать. */
  return p.replace(/\\/g, "/").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function describeOrFallback(
  file: ClassifiedFile,
  desc: SidecarDescription | undefined,
): { title: string; description: string; fullText?: string } {
  if (desc) {
    return {
      title: desc.title?.trim() || file.baseName,
      description: desc.description.trim(),
      fullText: desc.fullText,
    };
  }
  /* Нейтральный fallback: что это, по какому пути и какого размера. */
  const sizeKb = (file.size / 1024).toFixed(1);
  const human = file.kind === "image" ? "Illustration"
    : file.kind === "code" ? "Code example"
    : file.kind === "html-site" ? "Companion site"
    : "Companion file";
  return {
    title: file.baseName,
    description: `${human} (${file.ext}, ${sizeKb} KB). No description available — bundle was assembled without LLM annotation.`,
  };
}

/**
 * Разделяет sidecars на три группы для разных секций markdown.
 * Сортировка внутри группы — по relPath (стабильно).
 */
function partitionSidecars(sidecars: ClassifiedFile[]): {
  images: ClassifiedFile[];
  code: ClassifiedFile[];
  sites: ClassifiedFile[];
  extraBooks: ClassifiedFile[];
  rest: ClassifiedFile[];
} {
  const images: ClassifiedFile[] = [];
  const code: ClassifiedFile[] = [];
  const sites: ClassifiedFile[] = [];
  const extraBooks: ClassifiedFile[] = [];
  const rest: ClassifiedFile[] = [];
  for (const f of sidecars) {
    if (f.kind === "image") images.push(f);
    else if (f.kind === "code") code.push(f);
    else if (f.kind === "html-site") sites.push(f);
    else if (f.kind === "book") extraBooks.push(f);
    else if (f.kind !== "metadata") rest.push(f);
  }
  const byRel = (a: ClassifiedFile, b: ClassifiedFile) => a.relPath.localeCompare(b.relPath);
  images.sort(byRel); code.sort(byRel); sites.sort(byRel); extraBooks.sort(byRel); rest.sort(byRel);
  return { images, code, sites, extraBooks, rest };
}

export function buildBundleMarkdown(input: BundleMarkdownInput): string {
  const { bundle, bookMarkdown, bookTitle, bookAuthor, descriptions } = input;
  const desc = descriptions ?? new Map<string, SidecarDescription>();
  const out: string[] = [];

  const title = bookTitle?.trim() || (bundle.book ? bundle.book.baseName : path.basename(bundle.rootDir));
  out.push(`# ${title}`);
  if (bookAuthor) out.push(`\n*${bookAuthor}*`);
  if (bundle.warnings.length > 0) {
    out.push(`\n> Bundle assembly notes: ${bundle.warnings.join("; ")}`);
  }

  const { images, code, sites, extraBooks, rest } = partitionSidecars(bundle.sidecars);

  /* 1. Основная книга. */
  if (bookMarkdown.trim().length > 0) {
    out.push(`\n## Book contents\n`);
    out.push(bookMarkdown.trim());
  } else if (bundle.book) {
    out.push(`\n## Book contents\n`);
    out.push(`*Book file detected (${bundle.book.relPath}) but no extractable text.*`);
  }

  /* 2. Иллюстрации. */
  if (images.length > 0) {
    out.push(`\n## Illustrations & figures\n`);
    for (const img of images) {
      const d = describeOrFallback(img, desc.get(img.absPath));
      const rel = escapeMdInlinePath(img.relPath);
      out.push(`### ${d.title}\n`);
      out.push(`![${d.title}](${rel})\n`);
      out.push(d.description);
      if (d.fullText && d.fullText.trim().length > 0) {
        out.push(`\n<details><summary>OCR / extracted text</summary>\n\n${d.fullText.trim()}\n\n</details>`);
      }
    }
  }

  /* 3. Примеры кода. */
  if (code.length > 0) {
    out.push(`\n## Code examples\n`);
    for (const c of code) {
      const d = describeOrFallback(c, desc.get(c.absPath));
      const lang = langFor(c);
      out.push(`### ${d.title} (\`${c.relPath}\`)\n`);
      out.push(d.description);
      if (d.fullText && d.fullText.trim().length > 0) {
        out.push(`\n\`\`\`${lang}\n${d.fullText.trim()}\n\`\`\``);
      }
    }
  }

  /* 4. Скачанные сайты. */
  if (sites.length > 0) {
    out.push(`\n## Companion site material\n`);
    for (const s of sites) {
      const d = describeOrFallback(s, desc.get(s.absPath));
      out.push(`### ${d.title}\n`);
      out.push(`Path: \`${s.relPath}\``);
      out.push(d.description);
    }
  }

  /* 5. Доп. книги/издания (если несколько) — упоминаются, но НЕ инлайнятся. */
  if (extraBooks.length > 0) {
    out.push(`\n## Additional editions / supplementary books\n`);
    for (const b of extraBooks) {
      out.push(`- \`${b.relPath}\` (${b.ext}, ${(b.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  /* 6. Прочие файлы. */
  if (rest.length > 0) {
    out.push(`\n## Other companion files\n`);
    for (const r of rest) {
      const d = describeOrFallback(r, desc.get(r.absPath));
      out.push(`- **${d.title}** (\`${r.relPath}\`) — ${d.description}`);
    }
  }

  return out.join("\n").trim() + "\n";
}
