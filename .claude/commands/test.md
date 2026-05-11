---
description: Генерация тестов — pytest / Jest / Maestro, паттерн AAA
argument-hint: "<файл или функция или фича>"
---

# /test — Генерация тестов

Напиши тесты для указанной области. Выбери стек автоматически по типу проекта.

## Стек (выбирается по контексту)

| Слой | Фреймворк |
|------|-----------|
| Python | pytest + unittest.mock |
| Node/TS бэк | Jest или Vitest |
| React / React Native | Jest + @testing-library |
| Electron main/renderer | Vitest + electron-mocha |
| E2E mobile | Maestro YAML |
| E2E web | Playwright |

## Паттерн AAA

Каждый тест строго:
```
test_should_<expected>_when_<condition>:
  # Arrange
  <подготовка данных и моков>
  
  # Act
  <вызов тестируемого кода>
  
  # Assert
  <проверка результата>
```

## Naming convention

`test_should_[expected]_when_[condition]` — на любом языке (`it('should X when Y')` для JS).

## Что покрывать

1. **Golden path** — самый частый сценарий использования
2. **Edge cases**: пустой вход, max/min значения, unicode, очень большие/маленькие данные
3. **Error paths**: что если зависимость кинула, что если сеть отвалилась, что если БД недоступна
4. **Регрессии** — на каждый bug, который чинили, должен остаться тест

## Запреты

- Тесты, которые «всё мокают и ничего не проверяют» (`expect(fn).toHaveBeenCalled()` без проверки результата)
- Тесты, которые читают `process.env` напрямую (используй фикстуры)
- Тесты, которые зависят от порядка выполнения других тестов
- Тесты дольше 5 секунд для unit-уровня (для integration — отдельная папка)

Область: $ARGUMENTS
