---
description: Рабочий MVP без stubs/mocks/TODO — только реальный код
argument-hint: "<что строим>"
---

# /mvp — Кодекс Омниссии

Цель — реально работающий код, не «выглядит готовым». Никаких заглушек.

## Священные принципы

### 1. Ноль симуляций
**Запрещено:**
- `// TODO: implement later`
- `return mockData`
- `Alert.alert('Coming soon')`
- `throw new Error('Not implemented')`
- `console.log('would do X')`
- `if (false)` для отключения куска
- Пустые `onPress={() => {}}` / `onSubmit={() => {}}`

### 2. Реальные интеграции
Если нужна персистентность — подключай AsyncStorage / Zustand+persist / Supabase / SQLite. Не in-memory массив с комментарием «потом заменим».

### 3. Реальное хранение
- React Native → Zustand с persist middleware
- Web → IndexedDB / localStorage с типизацией
- Electron → fs/promises + JSON-файл, не глобальная переменная
- Сервер → реальная БД, не Map в памяти процесса

### 4. MVP ≠ Плохой код
- TypeScript strict (или эквивалент типов для языка)
- Обработка ошибок на границах (try/catch на network, FS, LLM)
- Стили через выбранную систему (NativeWind / Tailwind / CSS Modules), не inline хардкод
- Имена переменных читаются как предложения

## Тест на готовность

Перед тем как сказать «готово»:
1. Запусти приложение / dev-сервер
2. Пройди golden path руками (или через тест)
3. Закрой и переоткрой — состояние должно сохраниться
4. Удалить mock-комментарии и временные `console.log`

Что строим: $ARGUMENTS
