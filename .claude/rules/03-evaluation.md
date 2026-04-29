# 03 — Калибровка Оценщиков (Evaluator)

## Цель

По описанию книги (название, автор, темы, год, объём, издательство) выдать
оценку 0-10 для попадания в технический knowledge base.

## Шкала

| Score | Категория | Примеры |
|-------|-----------|---------|
| 9-10 | Эталон | CLRS, SICP, TAOCP, K&R, Type Theory and Formal Proof |
| 7-8 | Сильно | Effective Java, Designing Data-Intensive Applications, Pragmatic Programmer |
| 5-7 | Серая зона | Узкие книги, устаревшие, но влиятельные (JS Good Parts), новые без репутации |
| 3-4 | Слабо | Cookbook'и без глубины, маркетинговые «X for Dummies» |
| 1-2 | Шум | Self-help с техническим лоском, мотивашки, эзотерика |
| 0 | Не книга / fake | заголовок без содержания |

## Три якоря калибровки

Олимпиада обязана проверить ВСЕ ТРИ зоны. Если хоть одна не оценивается —
оценщик не пригоден.

1. **Верхняя планка** (`evaluator-clrs`): CLRS → должно быть **9-10**.
   Если модель ставит ≤7 — она недооценивает референсы и засорит датасет.

2. **Нижняя планка** (`evaluator-noise`): «Manifest your dreams through
   crystals» → должно быть **1-3**. Если модель ставит ≥5 — она пропустит
   эзотерику в технический датасет.

3. **Середина** (`evaluator-midrange`, `evaluator-nuanced`): visual git guide
   или JS:Good Parts → должно быть **5-7**. Здесь нужна **взвешенность**.

## Правила оценщика

### 1. Оценка ВСЕГДА с reasoning ≥30 chars
Голая цифра без объяснения — невалидна. В scorer'е длина reasoning влияет
на score.

### 2. Учитывать актуальность темы
Книга про Visual Basic 6 в 2026 году = автоматический penalty −2 даже
если автор Microsoft. Технологии устаревают.

### 3. Учитывать репутацию автора и издательства
- Прямой вес: Knuth/CLRS/Stroustrup/Lamport → +1-2.
- O'Reilly/MIT Press/Addison-Wesley → нейтрально-плюс.
- self-published / amazon-print → −1, требует доказательств качества.

### 4. Учитывать объём
- <100 страниц для технической темы — обычно поверхностно (−1).
- 200-600 — ожидаемая глубина.
- >1000 — энциклопедия (CLRS, TAOCP) — обычно +1 если репутация.

### 5. Бинарная честность («классика» vs «устарело»)
Если книга была influential, но **технология устарела** — нельзя ставить
9-10 за репутацию. Нужно балансировать. Тест `evaluator-nuanced`
проверяет именно это поведение.

### Пример взвешенной оценки (target для `evaluator-nuanced`)

```json
{
  "score": 6,
  "reasoning": "Influential classic that shaped JS coding style (Crockford,
   2008, O'Reilly), but covers only ES3/ES5. Predates ES6 features:
   let/const, classes, modules, async/await, arrow functions. Useful as
   historical reference but inadequate as standalone modern resource.
   Acceptable for KB only with caveats."
}
```

Score=6 — попадание в зелёную зону. Score=9 (как «классика») — overrating,
score=2 (как «устарело») — underrating, обе крайности дают ≤0.10 в scorer'е.

## Антипаттерны оценщиков

❌ **Авторство — единственный фактор.** «Это Knuth → 10», даже если книга
   не его. Решение: проверять и заголовок, и автора, и темы.

❌ **Год публикации — единственный фактор.** «Это 2008 → 2», даже если
   тема вечная (математика, теория алгоритмов). Решение: учитывать
   природу темы.

❌ **Шкала «всё хорошее = 8-10»**. Модель не использует диапазон 4-7.
   Решение: scorer штрафует за clustering у крайних точек.

❌ **Reasoning ≠ оценка.** Reasoning говорит «слабая книга», но score=8.
   Решение: проверка консистентности (regex по reasoning vs score).

## Thinking-модели в evaluator

- **На якорях** (clrs, noise, ru-classic) thinking не нужен — сигнал явный.
- **На середине** (midrange, nuanced) — thinking даёт +30% accuracy,
  потому что нужно держать в голове и плюсы и минусы одновременно.
- → Дисциплина `evaluator-nuanced` помечена `thinkingFriendly: true`.

## Производственная схема

```
chunk → crystallizer (extract) → bookMeta (collect) →
   evaluator (score 0-10) →
     if score >= 7  → keep, full extraction
     if 4 <= score <= 6 → keep with caveats
     if score <= 3  → drop, log to "noise" bucket
```

Threshold 7/4/3 — настраивается в settings UI.

## Связь с Олимпиадой

| Дисциплина | Цель | Thinking? |
|------------|------|-----------|
| `evaluator-clrs` | проверка верхней планки | ❌ нейтрально |
| `evaluator-noise` | проверка нижней планки | ❌ нейтрально |
| `evaluator-midrange` | проверка средней планки (Git guide) | ❌ нейтрально |
| `evaluator-ru-classic` | мультиязычность | ❌ нейтрально |
| `evaluator-nuanced` | взвешенная оценка серой зоны | ✅ thinking-friendly |

Финальный champion для роли evaluator должен показать score ≥0.6 на ВСЕХ
пяти дисциплинах. Иначе — он закроет глаза на одну из категорий.
