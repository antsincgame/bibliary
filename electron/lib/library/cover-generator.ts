/**
 * Synthetic Cover Generator — создаёт красивую обложку в стиле академической
 * (научной) литературы из метаданных книги, когда оригинальная обложка
 * недоступна или не была извлечена.
 *
 * Формат выхода: SVG-строка 600×850 px.
 * Браузер (Electron/Chromium) рендерит SVG-изображения нативно в <img>.
 * Хранится в CAS (.blobs/) как image/svg+xml — полностью идемпотентно.
 *
 * Стиль: Oxford/Springer academic — тёмный navy фон, золотые акценты,
 * засечный шрифт, геометрические декоративные элементы, строгая типографика.
 */

/** Безопасное экранирование для SVG text-content. */
function escSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Перенос текста по максимальной длине строки в символах.
 * Разбивает по пробелам, не ломает слова.
 */
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.slice(0, 4); // не более 4 строк заголовка
}

/** Усечение строки с многоточием. */
function ellipsis(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/**
 * Генерирует SVG-обложку в стиле научной/академической литературы.
 *
 * Структура:
 *   - Тёмно-синий градиентный фон (navy → midnight)
 *   - Двойная золотая рамка
 *   - Верхняя секция: логотип серии / издание
 *   - Центральная секция: название книги (крупно)
 *   - Разделитель + имя автора
 *   - Нижняя секция: год, домен, язык
 *   - Декоративные угловые элементы в стиле Springer
 *
 * @param meta - Метаданные книги
 * @returns SVG-строка, пригодная для хранения как image/svg+xml
 */
export function generateSyntheticCoverSvg(meta: {
  title?: string;
  author?: string;
  year?: number;
  domain?: string;
  language?: string;
  publisher?: string;
  sphere?: string;
}): string {
  const W = 600;
  const H = 850;

  const rawTitle = (meta.title || "Unknown Title").trim();
  const rawAuthor = (meta.author || "").trim();
  const year = meta.year ? String(meta.year) : "";
  const domain = (meta.domain || meta.sphere || "").trim();
  const lang = (meta.language || "").trim().toUpperCase().slice(0, 2);
  const publisher = (meta.publisher || "").trim();

  // Перенос заголовка
  const MAX_TITLE_CHARS = rawTitle.length > 60 ? 18 : rawTitle.length > 30 ? 22 : 26;
  const titleLines = wrapText(rawTitle, MAX_TITLE_CHARS);
  const fontSize = titleLines.length >= 4 ? 32 : titleLines.length === 3 ? 36 : titleLines.length === 2 ? 40 : 44;

  // Центр заголовка — примерно середина SVG со смещением вниз от header
  const TITLE_TOP = 330;
  const TITLE_LINE_H = fontSize * 1.35;
  const titleBlockH = titleLines.length * TITLE_LINE_H;
  const titleY = (H / 2) - (titleBlockH / 2) + 20;

  // Точки якоря элементов
  const SEPARATOR_Y = titleY + titleBlockH + 28;
  const AUTHOR_Y = SEPARATOR_Y + 38;
  const DOMAIN_Y = H - 130;
  const YEAR_Y = H - 105;
  const FOOTER_LINE_Y = H - 80;

  const authorShort = ellipsis(rawAuthor, 42);
  const domainShort = ellipsis(domain.toUpperCase(), 34);
  const pubShort = ellipsis(publisher, 30);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0e1526"/>
      <stop offset="60%" stop-color="#16213e"/>
      <stop offset="100%" stop-color="#0a0f1e"/>
    </linearGradient>
    <linearGradient id="goldLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#c9a84c" stop-opacity="0"/>
      <stop offset="20%" stop-color="#c9a84c" stop-opacity="1"/>
      <stop offset="80%" stop-color="#c9a84c" stop-opacity="1"/>
      <stop offset="100%" stop-color="#c9a84c" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- Outer border -->
  <rect x="18" y="18" width="${W - 36}" height="${H - 36}"
        fill="none" stroke="#c9a84c" stroke-width="1.8" opacity="0.7"/>
  <!-- Inner border -->
  <rect x="26" y="26" width="${W - 52}" height="${H - 52}"
        fill="none" stroke="#c9a84c" stroke-width="0.6" opacity="0.35"/>

  <!-- Corner ornaments (top-left) -->
  <line x1="18" y1="18" x2="72" y2="18" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <line x1="18" y1="18" x2="18" y2="72" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <!-- Corner ornaments (top-right) -->
  <line x1="${W - 18}" y1="18" x2="${W - 72}" y2="18" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <line x1="${W - 18}" y1="18" x2="${W - 18}" y2="72" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <!-- Corner ornaments (bottom-left) -->
  <line x1="18" y1="${H - 18}" x2="72" y2="${H - 18}" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <line x1="18" y1="${H - 18}" x2="18" y2="${H - 72}" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <!-- Corner ornaments (bottom-right) -->
  <line x1="${W - 18}" y1="${H - 18}" x2="${W - 72}" y2="${H - 18}" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>
  <line x1="${W - 18}" y1="${H - 18}" x2="${W - 18}" y2="${H - 72}" stroke="#c9a84c" stroke-width="3.5" opacity="0.9"/>

  <!-- Header separator -->
  <rect x="30" y="116" width="${W - 60}" height="1" fill="url(#goldLine)" opacity="0.6"/>

  <!-- Series / publisher header -->
  <text x="${W / 2}" y="82"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="15" fill="#c9a84c" text-anchor="middle"
        letter-spacing="4" opacity="0.9">БИБЛИАРИЙ</text>
  <text x="${W / 2}" y="104"
        font-family="'Arial Narrow', Arial, sans-serif"
        font-size="10" fill="#7a8faf" text-anchor="middle"
        letter-spacing="5" opacity="0.8">SCHOLARLY COLLECTION${lang ? "  ·  " + lang : ""}</text>

  <!-- Decorative dot pattern in header area -->
  <circle cx="${W / 2 - 120}" cy="88" r="2.5" fill="#c9a84c" opacity="0.25"/>
  <circle cx="${W / 2 - 80}" cy="88" r="1.5" fill="#c9a84c" opacity="0.18"/>
  <circle cx="${W / 2 + 80}" cy="88" r="1.5" fill="#c9a84c" opacity="0.18"/>
  <circle cx="${W / 2 + 120}" cy="88" r="2.5" fill="#c9a84c" opacity="0.25"/>

  <!-- Thin horizontal accent rule above title area -->
  <rect x="80" y="${titleY - 32}" width="${W - 160}" height="0.8"
        fill="url(#goldLine)" opacity="0.5"/>

  <!-- Title lines -->
  ${titleLines.map((line, i) => `<text x="${W / 2}" y="${titleY + i * TITLE_LINE_H}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="${fontSize}" fill="#ffffff" text-anchor="middle"
        font-weight="bold">${escSvg(line)}</text>`).join("\n  ")}

  <!-- Separator rule after title -->
  <rect x="100" y="${SEPARATOR_Y}" width="${W - 200}" height="1.2"
        fill="url(#goldLine)" opacity="0.7"/>

  <!-- Author -->
  ${authorShort ? `<text x="${W / 2}" y="${AUTHOR_Y}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="20" fill="#d4c89a" text-anchor="middle"
        font-style="italic">${escSvg(authorShort)}</text>` : ""}

  <!-- Footer separator -->
  <rect x="30" y="${FOOTER_LINE_Y}" width="${W - 60}" height="1"
        fill="url(#goldLine)" opacity="0.55"/>

  <!-- Domain -->
  ${domainShort ? `<text x="${W / 2}" y="${DOMAIN_Y}"
        font-family="'Arial Narrow', Arial, sans-serif"
        font-size="12" fill="#6d8aad" text-anchor="middle"
        letter-spacing="3">${escSvg(domainShort)}</text>` : ""}

  <!-- Year + publisher -->
  <text x="${W / 2}" y="${YEAR_Y}"
        font-family="Georgia, serif"
        font-size="14" fill="#8a9bb8" text-anchor="middle">
    ${[year, pubShort].filter(Boolean).map(escSvg).join(" · ")}
  </text>

  <!-- Decorative diamond at center bottom -->
  <polygon points="${W / 2},${H - 44} ${W / 2 + 7},${H - 37} ${W / 2},${H - 30} ${W / 2 - 7},${H - 37}"
           fill="none" stroke="#c9a84c" stroke-width="1.2" opacity="0.5"/>

  <!-- Subtle vertical lines on sides (texture) -->
  <line x1="50" y1="145" x2="50" y2="${H - 90}" stroke="#c9a84c" stroke-width="0.4" opacity="0.12"/>
  <line x1="${W - 50}" y1="145" x2="${W - 50}" y2="${H - 90}" stroke="#c9a84c" stroke-width="0.4" opacity="0.12"/>
</svg>`;
}
