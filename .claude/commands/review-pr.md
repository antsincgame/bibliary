---
description: Code review с категориями CRITICAL/WARNING/SUGGESTION/NOTE
argument-hint: "[PR# или ветка или diff target]"
---

# /review-pr — Code Review

Проанализируй изменения и выдай ревью по категориям. Будь конкретен — ссылайся на `file.ts:42`.

## Категории

| Уровень | Когда |
|---------|-------|
| 🔴 **CRITICAL** | Баг / уязвимость / data loss / production breakage |
| 🟡 **WARNING** | Опасный паттерн, технический долг, скрытая ловушка |
| 🟢 **SUGGESTION** | Можно лучше, но текущее не сломано |
| 💡 **NOTE** | Информация для автора, не требует действий |

## Чеклист

### Баги
- Edge cases: пустой вход, null, undefined, отрицательные числа, очень большие коллекции
- Race conditions: два параллельных вызова портят состояние
- Error handling: throw без catch, проглоченные ошибки, отсутствие cleanup
- Утечки ресурсов: незакрытые handles, subscriptions без unsubscribe, таймеры без clear

### Безопасность
- Хардкод секретов в коде / тестах / комментариях
- Валидация входа на доверенных границах (API, FS, IPC)
- Логи не должны содержать токены, пароли, PII
- SQL injection / XSS / command injection / path traversal

### Производительность
- O(n²) в hot path при большом n
- LLM-кэш для одинаковых запросов
- Утечки памяти (особенно closures, держащие большие объекты)
- React Native: FlatList vs map().map(), memo на тяжёлых компонентах

### Стиль и поддерживаемость
- Имена переменных читаются как предложения
- Функции < 40 строк (или явно обоснованное исключение)
- Дублирование 3+ блоков — выносится
- Комментарии объясняют **почему**, а не **что**

## Workflow

1. Если задан PR# — получи diff через GitHub MCP (`pull_request_read`, `get_pull_request_files`)
2. Если задана ветка/diff target — используй `git diff <target>...HEAD`
3. Без аргумента — ревью текущей рабочей копии (`git diff HEAD` + untracked)
4. Группируй замечания по файлам
5. В конце дай summary: `N CRITICAL, M WARNING, K SUGGESTION, L NOTE` + общий вердикт (merge-ready / нужны правки / нужен redesign)

Цель ревью: $ARGUMENTS
