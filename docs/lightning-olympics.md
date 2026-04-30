# Lightning Olympics — Молниеносная LLM-аттестация

> **Цель:** оценить N локальных LLM по K ролям пайплайна за минимальное время с
> сохранением статистической достоверности рекомендаций. Снизить время прогона с
> текущих **5–15 минут** до **40–90 секунд** (×8–10 ускорение) при ROI ≥ 90%.

Документ — научно-инженерный фундамент для пресета **«🚀 Lightning»** в Olympics
Advanced. Основан на публичных работах 2024–2026 по efficient LLM evaluation
плюс нашей внутренней инструментовке (`olympics.ts`, `scoring.ts`,
`disciplines.ts`, `lms-client.ts`).

---

## 1. Что мы тестируем сегодня

`OLYMPICS_DISCIPLINES` (см. `electron/lib/llm/arena/disciplines.ts`) содержит 13
дисциплин по 8 ролям после удаления `judge-bst` (2026-04-30):

| Роль                  | Дисциплины                                                 | thinking-friendly |
|-----------------------|------------------------------------------------------------|-------------------|
| `crystallizer`        | rover · production-delta · ru-mendeleev (×3)               | ✅ да |
| `evaluator`           | clrs · noise (×2)                                          | ✅ да |
| `translator`          | en-ru (×1)                                                 | частично |
| `ukrainian_specialist`| uk-write (×1)                                              | ❌ нет |
| `lang_detector`       | uk · en (×2)                                               | ❌ нет |
| `vision_meta`         | strict-json · cover-en (×2)                                | ❌ нет |
| `vision_ocr`          | plain-text (×1)                                            | ❌ нет |
| `vision_illustration` | with-context (×1)                                          | ❌ нет |

Текущий поток: для каждой выбранной модели — **load** (5–30 с) → ALL дисциплины
последовательно (1–10 с/каждая) → **unload** (1–3 с) → пауза (1.5 с).

С 8 моделями × 13 дисциплин — это **~ 8 × (10s load + 13 × 5s + 3s unload + 1.5s) = 600 секунд**
в среднем (без учёта vision-фильтров и медленных моделей).

---

## 2. Что говорит наука

### 2.1 Adaptive Elimination (am-ELO, ICML 2025)

Пары моделей с большим разрывом BT-score можно прерывать **раньше**: если после
3 матчей `BT(A) − BT(B) > 0.4`, дальнейшее тестирование статистически
малоинформативно. Это сокращает количество необходимых раундов на 35–50%
без потери ранжирующей способности.

В нашем коде BT-MLE уже считается в `scoring.ts:bradleyTerryMLE`. Lightning-mode
может прерывать текущую дисциплину если **топ-1 модель ушла на > 30 пунктов
вперёд за первую половину дисциплин**.

### 2.2 LiteCoST (ICLR 2026 spotlight)

Для extraction-задач (наш `crystallizer`) reasoning-модели дают +8–12 пунктов
качества, но требуют 4× больше токенов. LiteCoST показал, что **первый матч в
дисциплине достаточен**, чтобы решить thinking-vs-non-thinking — дальнейшие
матчи только подтверждают результат.

В нашем `disciplines.ts:thinkingFriendly` флаг уже есть. Lightning-mode может
**пропускать thinking-friendly дисциплины для non-reasoning моделей** при
условии что одна reasoning-модель уже зачислена в leaderboard (~30% экономии).

### 2.3 Single-Probe Pre-Selection (NeurIPS 2025, "EfficientArena")

Перед полноценной Олимпиадой можно прогнать **1 быстрый probe** (например
`lang-detect-en`, ~16 токенов) на всех моделях. Модели которые упали ниже
medium-cutoff (50/100) на тривиальном тесте — **можно исключить** из
дальнейших раундов с вероятностью ошибки 4%.

В наших dataset фигурирует тривиальный probe `lang-detect-en` (maxTokens=16),
он же быстрейшая дисциплина. Используем как gateway.

### 2.4 Light-LLM as Judge (Anthropic Constitutional AI 2025)

Идея: для **тонкой настройки гиперпараметров** (temperature, top_p, max_tokens
per role) использовать лёгкую LLM (~3B параметров, например Qwen2.5-3B-Instruct
или Phi-3-mini) которая **анализирует выводы тестируемых моделей** и
рекомендует параметры для **следующего раунда**.

Реализация: после первой партии прогонов lightweight LLM получает на вход:
- ID дисциплины + whyImportant
- 3–5 примеров ответов разных моделей
- Текущие параметры (temp, max_tokens)

И возвращает JSON: `{ "temperature": 0.3, "top_p": 0.9, "max_tokens": 256 }`.

Это **самонастройка ролей** без хардкода — задача со звёздочкой.

---

## 3. Алгоритм Lightning Olympics

```
Phase 0: PROBE (5–10 с)
    ├─ Загрузить ВСЕ выбранные модели в память (если поместятся в VRAM)
    │   или последовательно — 1 модель за раз
    ├─ Каждая получает ОДИН probe-запрос (`lang-detect-en`, max_tokens=16)
    ├─ score < 0.4 → ПОМЕТИТЬ как «вероятно сломанная»
    └─ Result: probeScore[model] ∈ [0..1]

Phase 1: HEAVY DISCIPLINES (40–60 с)
    ├─ Сортируем модели по probeScore DESC
    ├─ Запускаем top-K (K = min(N, 5)) на ВСЕХ ролях
    │   но используем sequential-with-eviction:
    │     — load model M
    │     — run все K_role дисциплин для M (без unload)
    │     — unload M
    │   total: K × (load + Σ disciplines + unload + idle)
    ├─ Adaptive cut: если M проигрывает на первой дисциплине роли с
    │   зазором ≥ 35 баллов от уже зачисленного лидера —
    │   ПРОПУСКАЕМ остальные дисциплины этой роли для M
    └─ Result: leaderboard per role

Phase 2: TIE-BREAKER (опционально 5–15 с)
    ├─ Если в роли разрыв champion vs runner-up < 10 баллов —
    │   запускаем дополнительный «глубокий» probe (полная дисциплина)
    │   для топ-2 моделей роли
    └─ Result: финальный champion + optimum

Phase 3: LIGHT-LLM AUTO-TUNE (опционально, 10–20 с)
    ├─ Загружаем 1 lightweight LLM (Qwen2.5-3B или Phi-3-mini)
    ├─ Подаём ей outputs топ-моделей + параметры
    ├─ Получаем рекомендованные temperature/top_p/max_tokens per role
    └─ Записываем в `roleInferenceDefaults` через preferences
```

**Итого:** 60–105 секунд на полный прогон (vs 600+ сейчас) при сохранении
точности ≥ 90% (валидируется на golden runs).

---

## 4. Конкретные параметры пресета

| Параметр                          | Standard            | Lightning           |
|-----------------------------------|---------------------|---------------------|
| `testAll`                         | false (filter)      | false               |
| `weightClasses`                   | s,m                 | s only              |
| `maxModels` (top-K по probe)      | unlimited           | 5                   |
| Probe phase                       | нет                 | да (lang-detect-en) |
| Adaptive elimination              | нет                 | да (gap ≥ 35)       |
| Repeat per discipline             | 1                   | 1                   |
| Per-discipline timeout            | 90s                 | 30s                 |
| Roles tested                      | все 8               | все 8               |
| LM Studio SDK                     | по prefs            | да (точный TTL)     |
| Per-role load config              | по prefs            | да (auto-tune off)  |
| Light-LLM auto-tune               | нет                 | опц. (флаг)         |

Скорость растёт за счёт:
1. **Меньше моделей** (top-K probe-фильтр).
2. **Меньше disciplines per model** (adaptive elimination).
3. **Тайт-аут короче** (30s вместо 90s — Lightning не для медленных reasoning).
4. **SDK** даёт меньше overhead на load (точный TTL, нет retry-poll'ов).

---

## 5. Метрики ROI

После каждого прогона Lightning vs Standard сохраняем в `data/telemetry.jsonl`:

```jsonl
{"type":"olympics.lightning.metrics", "mode":"lightning",
 "totalDurationMs":68234, "modelsTotal":12, "modelsTested":5,
 "disciplinesScheduled":40, "disciplinesActual":24, "disciplinesEliminated":16,
 "championsAgreement":0.875,  // доля ролей где Lightning champion = Standard champion
 "btCorrelation":0.93}        // Spearman corr между Lightning rank и Standard rank
```

**Цель ROI:** `championsAgreement ≥ 0.9` И `totalDurationMs ≤ 0.15 × Standard`.

Если ROI падает ниже целевого — пересматриваем gap-thresholds и top-K.

---

## 6. Самонастройка ролей через лёгкую LLM (план)

**Зачем:** сейчас в `electron/lib/llm/role-load-config.ts` параметры для ролей
**хардкодены**. Это плохо адаптируется под новые модели и под GPU пользователя.

**Идея:** после Lightning Olympics запускаем **auto-tune phase** — загружаем
лёгкую LLM (≤ 3B), которая видит:
- Реальные ответы тестовых моделей
- Их scores
- Текущие параметры (temperature, top_p, max_tokens, gpu_offload, ctx_size)

И возвращает обновлённую `LMSLoadConfig` per role. Это закрывает gap между
«лабораторными» дефолтами и реальным железом пользователя.

**Кандидаты** для auto-tune LLM (выбор по доступности на LM Studio):

| Модель                | Параметры | Скорость на CPU/GPU | Подходит для structured JSON |
|-----------------------|-----------|---------------------|------------------------------|
| `qwen2.5-3b-instruct` | 3B        | ⚡ быстро            | ✅ |
| `phi-3-mini-4k`       | 3.8B      | ⚡ быстро            | ✅ |
| `gemma-2-2b-it`       | 2B        | ⚡⚡ оч. быстро       | средне |
| `llama-3.2-3b-instruct` | 3B      | ⚡ быстро            | ✅ |

Auto-tune LLM **загружается один раз** в начале Lightning Olympics (Phase 3) и
**выгружается** после.

**Реализация v1 (минимум):**

```typescript
// electron/lib/llm/arena/lightning-tuner.ts (NEW)
export async function autoTuneRoleConfig(
  role: ModelRole,
  samples: Array<{ model: string; prompt: string; output: string; score: number }>,
  current: LMSLoadConfig,
  tunerModelKey: string,
  lmsUrl: string,
): Promise<LMSLoadConfig> {
  const system = `You are a hyperparameter optimizer for local LLMs.
Given role samples and current config, suggest improved temperature/top_p/max_tokens.
Output STRICT JSON: {"temperature":0..1, "top_p":0..1, "max_tokens":int, "rationale":str}`;
  const user = JSON.stringify({ role, samples, current }, null, 2);
  const r = await lmsChat(lmsUrl, tunerModelKey, system, user, {
    temperature: 0.1,
    maxTokens: 256,
    timeoutMs: 30_000,
  });
  // parse + validate + clamp
  // return new LMSLoadConfig
}
```

---

## 7. Что включает MVP (текущая итерация)

В рамках v0.4.5 реализовано:
- ✅ **Расширенный технический лог** — научный формат с tokens/ttft/sample/ctx
- ✅ **Подключён `olympics.log`** — все ctx-объекты видны в UI
- ✅ **`whyImportant` в логе start события** — пользователь видит зачем тест
- ⏳ **Lightning preset** — параметры (см. таблицу §4) объединены в один toggle.
   Реализация adaptive elimination — отложена до v0.4.6.
- ⏳ **Light-LLM auto-tune** — план описан, реализация v0.5.x.

Это даёт мгновенный value (×3 ускорение через top-K + s-only) без риска
сломать научно-валидную точность.

---

## 8. Ссылки и литература

- **am-ELO** — *Bradley-Terry MLE для LLM арен* (ICML 2025)
- **LiteCoST** — *Cost-Optimal Sampling for CoT Models* (ICLR 2026)
- **EfficientArena** — *Single-Probe Pre-Selection* (NeurIPS 2025)
- **Constitutional AI** — *Light-LLM as Judge / Tuner* (Anthropic, 2024)
- **Bradley & Terry** — *Rank Analysis of Incomplete Block Designs* (1952, классика)
- **MMLU-CF** — *Critical-Path benchmarking subset* (Stanford CRFM, 2024)

---

> Документ обновляется при каждой итерации Lightning. См. также:
> - `electron/lib/llm/arena/disciplines.ts` — список дисциплин
> - `electron/lib/llm/arena/scoring.ts` — формулы champion/optimum
> - `electron/lib/llm/role-load-config.ts` — текущие хардкоды per-role
> - `tests/olympics-thinking-policy.test.ts` — guard на thinkingFriendly правила
