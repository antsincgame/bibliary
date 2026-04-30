/**
 * Translator — перевод произвольного текста на русский/английский с защитой
 * от деградации контекста LLM.
 *
 * ПРИНЦИП: длинный текст режется на маленькие самостоятельные чанки
 * (300-500 слов) и каждый переводится отдельным коротким вызовом. Между
 * вызовами контекст НЕ передаётся — это исключает «забывание» и зацикливание
 * на длинных украинских/смешанных книгах.
 *
 * РОЛЬ: использует `modelRoleResolver.resolve("translator")`. Если роль не
 * настроена, кидает осмысленную ошибку — pipeline должен решить, обходить
 * перевод или фейлить импорт.
 */

import { chatWithPolicy } from "../../lmstudio-client.js";
import { modelRoleResolver } from "./model-role-resolver.js";
import { getPreferencesStore } from "../preferences/store.js";
import { getModelPool } from "./model-pool.js";

export type TargetLang = "ru" | "en";

export interface TranslateOptions {
  /** Целевой язык. Если не задан — берётся из prefs.translatorTargetLang. */
  targetLang?: TargetLang;
  /** Hint об исходном языке (ISO-639-1, например "uk"). Помогает модели. */
  sourceLang?: string;
  /** Максимум слов в одном чанке. Default 400. */
  chunkWords?: number;
  signal?: AbortSignal;
  /** Колбэк прогресса: вызывается после каждого переведённого чанка. */
  onProgress?: (info: { chunkIndex: number; totalChunks: number }) => void;
}

/** Маркер-разделитель параграфов для batch-перевода. Выбран так, что даже
 *  «капризные» модели не лезут его трогать — нет markdown-смысла, нет
 *  spacing-ловушек. */
export const PARAGRAPH_MARKER = "\n[[¶P¶]]\n";

const DEFAULT_CHUNK_WORDS = 400;

const SYSTEM_PROMPTS: Record<TargetLang, string> = {
  ru:
    "You are a professional translator. Translate the user's text into Russian. " +
    "Preserve technical terms, proper names, code snippets, formulas and numbers exactly as in the source. " +
    "Output ONLY the translation. No commentary, no quotes, no explanations.",
  en:
    "You are a professional translator. Translate the user's text into English. " +
    "Preserve technical terms, proper names, code snippets, formulas and numbers exactly as in the source. " +
    "Output ONLY the translation. No commentary, no quotes, no explanations.",
};

/**
 * Режет текст на чанки по `chunkWords` слов. Старается резать по абзацам,
 * чтобы не разваливать предложения.
 */
export function splitForTranslation(text: string, chunkWords: number = DEFAULT_CHUNK_WORDS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;

  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean).length;
    if (words === 0) continue;

    if (words >= chunkWords) {
      if (current) {
        chunks.push(current.trim());
        current = "";
        currentWords = 0;
      }
      const tokens = para.split(/\s+/);
      for (let i = 0; i < tokens.length; i += chunkWords) {
        chunks.push(tokens.slice(i, i + chunkWords).join(" "));
      }
      continue;
    }

    if (currentWords + words > chunkWords && current) {
      chunks.push(current.trim());
      current = para;
      currentWords = words;
    } else {
      current = current ? `${current}\n\n${para}` : para;
      currentWords += words;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Группирует параграфы в батчи (≤chunkWords слов в каждом), кодирует
 * параграфы внутри батча с PARAGRAPH_MARKER, отправляет батч одним вызовом,
 * восстанавливает структуру параграфов на выходе.
 *
 * Зачем: одна книга может содержать 1000+ параграфов. Per-paragraph вызов
 * это 1000 LLM-запросов = неприемлемо. Batch-стратегия даёт ~50 вызовов на
 * среднюю книгу, при этом сохраняет границы параграфов.
 *
 * Если модель «съела» маркер — возвращаемся на детерминированный fallback
 * (вход N абзацев → выход N сегментов через split по \n\n).
 */
export interface TranslateParagraphsOptions extends TranslateOptions {
  /** Целевой размер батча в словах. Default 400. */
  batchWords?: number;
}

export interface TranslateParagraphsResult {
  /** Переведённые параграфы — длина и порядок СОВПАДАЮТ со входом. */
  paragraphs: string[];
  modelKey: string;
  targetLang: TargetLang;
  llmCalls: number;
  /** Параграфы, которые не удалось обратно сопоставить (fallback использован). */
  fallbackUsed: number;
}

export async function translateParagraphs(
  paragraphs: string[],
  opts: TranslateParagraphsOptions = {},
): Promise<TranslateParagraphsResult> {
  if (paragraphs.length === 0) {
    const prefs = await getPreferencesStore().getAll();
    return {
      paragraphs: [],
      modelKey: "",
      targetLang: opts.targetLang ?? prefs.translatorTargetLang,
      llmCalls: 0,
      fallbackUsed: 0,
    };
  }

  const prefs = await getPreferencesStore().getAll();
  const targetLang: TargetLang = opts.targetLang ?? prefs.translatorTargetLang;
  const batchWords = opts.batchWords ?? DEFAULT_CHUNK_WORDS;

  const resolved = await modelRoleResolver.resolve("translator");
  if (!resolved) {
    throw new Error(
      "Translator model is not configured. Open «Models» and pick a translator (e.g. Qwen2.5, Aya 23, Gemma 2).",
    );
  }
  const modelKey = resolved.modelKey;

  /* Группируем параграфы в батчи по batchWords. Каждый параграф целиком в одном
     батче — параграф не дробится между вызовами. */
  const batches: string[][] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const p of paragraphs) {
    const pw = p.split(/\s+/).filter(Boolean).length || 1;
    if (curWords + pw > batchWords && cur.length > 0) {
      batches.push(cur);
      cur = [p];
      curWords = pw;
    } else {
      cur.push(p);
      curWords += pw;
    }
  }
  if (cur.length > 0) batches.push(cur);

  const SYSTEM = `${SYSTEM_PROMPTS[targetLang]}\n\n` +
    `IMPORTANT: paragraphs are separated by the marker ${PARAGRAPH_MARKER.trim()}. ` +
    `Preserve this marker EXACTLY between paragraphs in your output. ` +
    `Do not merge paragraphs, do not skip them, do not add any extra paragraphs.`;
  const sourceHint = opts.sourceLang ? `Source language: ${opts.sourceLang}.\n\n` : "";

  /* Pool: единый acquire на все батчи параграфов одной книги.
     На средней книге это ≈50 chat-вызовов под одной моделью без перезагрузок. */
  return getModelPool().withModel(
    modelKey,
    { role: "translator", ttlSec: 1800, gpuOffload: "max" },
    async () => {
      const out: string[] = [];
      let fallbackUsed = 0;
      let llmCalls = 0;

      for (let bi = 0; bi < batches.length; bi++) {
        if (opts.signal?.aborted) throw new Error("Translation aborted");
        const batch = batches[bi]!;
        const joined = batch.join(PARAGRAPH_MARKER);

        const resp = await chatWithPolicy(
          {
            model: modelKey,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: `${sourceHint}${joined}` },
            ],
            sampling: {
              temperature: 0.1,
              top_p: 0.9,
              top_k: 20,
              min_p: 0,
              presence_penalty: 0,
              max_tokens: Math.max(1024, Math.ceil(joined.length * 2)),
            },
          },
          { externalSignal: opts.signal },
        );
        llmCalls++;
        opts.onProgress?.({ chunkIndex: bi + 1, totalChunks: batches.length });

        const segments = resp.content
          .split(PARAGRAPH_MARKER)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        if (segments.length === batch.length) {
          out.push(...segments);
        } else {
          /* fallback: модель потеряла/добавила маркеры. Делим по \n\n; если
             всё равно не сходится — приклеиваем единым параграфом к каждому
             входному (чтобы потерять разметку, а не данные). */
          const byBlankLine = resp.content
            .split(/\n\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (byBlankLine.length === batch.length) {
            out.push(...byBlankLine);
          } else if (byBlankLine.length > 0) {
            fallbackUsed += batch.length;
            const merged = byBlankLine.join("\n\n");
            for (let i = 0; i < batch.length; i++) {
              out.push(i === 0 ? merged : "");
            }
          } else {
            fallbackUsed += batch.length;
            for (const _p of batch) out.push(resp.content.trim());
          }
        }
      }

      return { paragraphs: out, modelKey, targetLang, llmCalls, fallbackUsed };
    },
  );
}

/**
 * Перевести `ParseResult`-подобную книгу in-place: каждый параграф каждой
 * секции прогоняется через `translateParagraphs`. Если параграф пуст или
 * перевод вернул пусто — оригинал сохраняется (защита от потери данных).
 */
export interface TranslateBookSection {
  paragraphs: string[];
  /** Прочие поля секции остаются нетронутыми — мы их не знаем здесь. */
}

export interface TranslateBookOptions extends TranslateParagraphsOptions {
  onSectionProgress?: (info: {
    sectionIndex: number;
    totalSections: number;
    paragraphsTranslated: number;
  }) => void;
}

export async function translateBookSections<S extends TranslateBookSection>(
  sections: S[],
  opts: TranslateBookOptions = {},
): Promise<{ totalParagraphs: number; llmCalls: number; fallbackUsed: number; modelKey: string }> {
  let total = 0;
  let calls = 0;
  let fallback = 0;
  let modelKey = "";

  for (let si = 0; si < sections.length; si++) {
    if (opts.signal?.aborted) throw new Error("Translation aborted");
    const sect = sections[si]!;
    if (sect.paragraphs.length === 0) {
      opts.onSectionProgress?.({ sectionIndex: si, totalSections: sections.length, paragraphsTranslated: 0 });
      continue;
    }
    const r = await translateParagraphs(sect.paragraphs, opts);
    /* безопасность: если длины не совпали (защитный fallback оставил пустоты),
       не теряем оригиналы — пустые элементы заменяем оригиналом. */
    const replaced = sect.paragraphs.map((src, i) => {
      const tr = r.paragraphs[i];
      return tr && tr.trim().length > 0 ? tr : src;
    });
    sect.paragraphs = replaced;
    total += sect.paragraphs.length;
    calls += r.llmCalls;
    fallback += r.fallbackUsed;
    modelKey = r.modelKey || modelKey;
    opts.onSectionProgress?.({
      sectionIndex: si,
      totalSections: sections.length,
      paragraphsTranslated: r.paragraphs.length,
    });
  }

  return { totalParagraphs: total, llmCalls: calls, fallbackUsed: fallback, modelKey };
}
