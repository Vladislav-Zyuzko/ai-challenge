Задача решена. Решение — в файле `solution.dart` в рабочей папке.

## Алгоритм

Классическое **скользящее окно** с двумя указателями за O(|s| + |t|):

1. Считаю частоты символов `t` в словарь `need`.
2. Расширяю правый указатель, добавляя символы в окно; когда символ достигает требуемой кратности — увеличиваю счётчик `formed`.
3. Как только `formed == need.length` (окно покрывает весь `t`), сжимаю окно слева, запоминая самое короткое валидное окно, пока условие ещё выполняется.
4. Возвращаю подстроку лучшего окна либо `""`, если его нет.

Особенности реализации:
- работаю с **кодовыми пунктами (runes)**, а не UTF-16 code units, поэтому корректно обрабатываются астральные символы (эмодзи и т.п.); параллельно храню смещения каждого rune в исходной строке для точного `s.substring(...)`;
- ранние выходы: `t == ""` → `""`, `s.length < t.length` → `""` (безопасно и в юникоде);
- повторяющиеся символы `t` учитываются через кратности.

## Проверка

`main()` в файле прогоняет все примеры из условия и дополнительные краевые случаи (пустые строки, кратность, обратный порядок, юникод вне BMP) — **все 15 тестов PASS**. Дополнительно провёл кросс-проверку на 3000 случайных строках против полного перебора — расхождений нет.

Запуск: `dart run solution.dart` (в среде есть Dart SDK 3.9.2).

```dart
String minWindow(String s, String t) {
  if (t.isEmpty) return '';
  if (s.length < t.length) return '';

  final need = <int, int>{};
  for (final ch in t.runes) {
    need[ch] = (need[ch] ?? 0) + 1;
  }

  final points = <int>[];
  final offsets = <int>[];
  var pos = 0;
  for (final ch in s.runes) {
    points.add(ch);
    offsets.add(pos);
    pos += ch > 0xFFFF ? 2 : 1;
  }

  var formed = 0;
  final window = <int, int>{};
  var bestStart = 0;
  var bestLength = -1;
  var left = 0;

  for (var right = 0; right < points.length; right++) {
    final ch = points[right];
    if (need.containsKey(ch)) {
      window[ch] = (window[ch] ?? 0) + 1;
      if (window[ch] == need[ch]) formed++;
    }

    while (formed == need.length && left <= right) {
      final currentLength = right - left + 1;
      if (bestLength == -1 || currentLength < bestLength) {
        bestLength = currentLength;
        bestStart = left;
      }
      final leftCh = points[left];
      if (need.containsKey(leftCh)) {
        window[leftCh] = window[leftCh]! - 1;
        if (window[leftCh]! < need[leftCh]!) formed--;
      }
      left++;
    }
  }

  if (bestLength == -1) return '';
  final start = offsets[bestStart];
  final end = bestStart + bestLength < offsets.length
      ? offsets[bestStart + bestLength]
      : s.length;
  return s.substring(start, end);
}
```

