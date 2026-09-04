Готово. Функция `minWindow` реализована на Dart (скользящее окно с двумя указателями, O(|s| + |t|)) и проверена запуском на Dart SDK 3.4.1.

```dart
String minWindow(String s, String t) {
  if (s.isEmpty || t.isEmpty || t.length > s.length) return '';

  final need = <String, int>{};
  for (var i = 0; i < t.length; i++) {
    need[t[i]] = (need[t[i]] ?? 0) + 1;
  }

  final have = <String, int>{};
  var left = 0;
  var matched = 0;
  var minLen = s.length + 1;
  var start = 0;

  for (var right = 0; right < s.length; right++) {
    final c = s[right];
    have[c] = (have[c] ?? 0) + 1;
    if (need.containsKey(c) && have[c] == need[c]) {
      matched++;
    }

    while (matched == need.length) {
      final len = right - left + 1;
      if (len < minLen) {
        minLen = len;
        start = left;
      }
      final lc = s[left];
      have[lc] = have[lc]! - 1;
      if (need.containsKey(lc) && have[lc]! < need[lc]!) {
        matched--;
      }
      left++;
    }
  }

  return minLen == s.length + 1 ? '' : s.substring(start, start + minLen);
}
```

Результат прогона на трёх примерах из условия:

| s | t | Возвращено | Ожидалось | Совпадает |
|---|---|---|---|---|
| `ADOBECODEBANC` | `ABC` | `BANC` | `BANC` | ✅ да |
| `a` | `a` | `a` | `a` | ✅ да |
| `a` | `aa` | `""` (пустая) | `""` | ✅ да |

Дополнительно функция проверена на крайних случаях (пустые `s`/`t`, `t` длиннее `s`, отсутствующие символы, регистр `AbcdeF`/`bDF` → `""`, повторы `aa`+`aa` → `aa`, `aaaaaaaaaa`+`aaa` → `aaa` и др.) — все результаты сверены с полным перебором (brute force) и совпали (`ALL OK`).

