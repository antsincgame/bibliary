/**
 * Layout pipeline: smart typography (typograf wrapper).
 *
 * typograf (MIT, npm) — российский typography engine, превращает
 *   "Привет - мир!"  →  «Привет — мир!»
 *   "10 кг"          →  10&nbsp;кг
 *   "..."            →  …
 *
 * Используется для русско/англоязычной научной литературы Bibliary.
 * Code blocks защищены отдельно через layout-protect-code.ts —
 * typograf здесь видит только прозу и плейсхолдеры (которые не трогает,
 * т.к. это NUL-символ + ASCII-маркер, никаким typograf-правилом
 * не покрытый).
 */
import Typograf from "typograf";

/* Один инстанс на язык — typograf инициализирует ~150 правил при new(),
   создавать новый на каждый вызов было бы 10× дороже по CPU. */
const TP_RU = new Typograf({ locale: ["ru", "en-US"] });
const TP_EN = new Typograf({ locale: ["en-US"] });

/* Отключаем правила, которые ломают markdown и Tufte HTML:
   - common/punctuation/quote: typograf не трогает уже HTML-теги, но
     внутри атрибутов вроде `class="lib-reader-callout"` могут быть
     случайные кавычки — конфликт исключаем точечно. */
TP_RU.disableRule("common/space/trimRight");
TP_EN.disableRule("common/space/trimRight");

export type LayoutLang = "ru" | "en";

/**
 * Применяет typographic refinements к markdown body.
 *
 * Безопасно для:
 *  - markdown синтаксиса (typograf обходит # / ## / [ ] / ! заголовки);
 *  - HTML-вкраплений (typograf не лезет внутрь tags);
 *  - code-плейсхолдеров (символ NUL никаким правилом не покрыт).
 *
 * @param md — markdown с защищёнными code-блоками.
 * @param lang — язык; для смешанных книг используется "ru" (включает en).
 */
export function applyTypograf(md: string, lang: LayoutLang = "ru"): string {
  if (!md) return md;
  const tp = lang === "en" ? TP_EN : TP_RU;
  try {
    return tp.execute(md);
  } catch {
    /* typograf никогда не должен падать на нашем контенте, но если
       вдруг — отдаём оригинал, чем пускаем поход под откос. */
    return md;
  }
}
