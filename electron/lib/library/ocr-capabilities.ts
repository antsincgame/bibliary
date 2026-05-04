/**
 * Агрегирующая проверка готовности OCR-движков для импорта image-only книг.
 *
 * Используется preflight'ом перед импортом папки, чтобы заранее предупредить
 * пользователя: «у вас 35 файлов без text-layer, при этом ни system OCR, ни
 * vision-LLM не настроены — эти файлы вернут пусто».
 *
 * Возвращаемая структура — одна точка истины для UI: можно показать какой
 * движок работает, какие языки распознаёт, и подсказать что настроить.
 */

import { getOcrSupport, type OcrSupportInfo } from "../scanner/ocr/index.js";
import { modelRoleResolver } from "../llm/model-role-resolver.js";
import { readPipelinePrefsOrNull } from "../preferences/store.js";

export interface OcrCapabilities {
  systemOcr: {
    available: boolean;
    platform: NodeJS.Platform;
    languages: string[];
    /** Причина, если available=false (например, "system OCR available only on win32/darwin"). */
    reason?: string;
  };
  visionLlm: {
    available: boolean;
    /** modelKey разрешённой модели (если available=true). */
    modelKey?: string;
    /** Причина если available=false ("no model assigned to vision_ocr role" / "no vision-capable models loaded" / etc). */
    reason?: string;
  };
  /** Хотя бы один OCR-движок доступен — image-only книги имеют шанс на текст. */
  anyAvailable: boolean;
}

export async function getOcrCapabilities(): Promise<OcrCapabilities> {
  const support: OcrSupportInfo = getOcrSupport();
  const prefs = await readPipelinePrefsOrNull();
  const langs = prefs?.ocrLanguages ?? ["en", "ru", "uk"];

  const systemOcr: OcrCapabilities["systemOcr"] = {
    available: support.supported,
    platform: support.platform,
    languages: support.supported ? langs : [],
  };
  if (!support.supported && support.reason) {
    systemOcr.reason = support.reason;
  }

  let visionLlm: OcrCapabilities["visionLlm"];
  try {
    const resolved = await modelRoleResolver.resolve("vision_ocr");
    if (resolved) {
      visionLlm = { available: true, modelKey: resolved.modelKey };
    } else {
      visionLlm = {
        available: false,
        reason: "no vision-capable model loaded in LM Studio (assign one in Models → vision_ocr)",
      };
    }
  } catch (err) {
    visionLlm = {
      available: false,
      reason: `vision_ocr role check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    systemOcr,
    visionLlm,
    anyAvailable: systemOcr.available || visionLlm.available,
  };
}
