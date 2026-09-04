/// Возвращает минимальную подстроку [s], содержащую все символы [t]
/// с учётом кратности, либо пустую строку, если такой подстроки нет.
///
/// Алгоритм: скользящее окно (two pointers) за O(|s| + |t|).
String minWindow(String s, String t) {
  if (s.isEmpty || t.isEmpty || t.length > s.length) return '';

  // Сколько каких символов нужно.
  final need = <String, int>{};
  for (var i = 0; i < t.length; i++) {
    final c = t[i];
    need[c] = (need[c] ?? 0) + 1;
  }

  // Счётчик ещё недостающих символов окна.
  var missing = need.length;

  var left = 0;
  var bestLeft = 0;
  var bestLen = 1 << 30; // бесконечность

  final have = <String, int>{};

  for (var right = 0; right < s.length; right++) {
    final c = s[right];
    if (need.containsKey(c)) {
      have[c] = (have[c] ?? 0) + 1;
      // Символ стал "покрытым": когда текущего количества достаточно.
      if (have[c] == need[c]) missing--;
    }

    // Пока окно полно, пытаемся сжимать его слева.
    while (missing == 0) {
      final len = right - left + 1;
      if (len < bestLen) {
        bestLen = len;
        bestLeft = left;
      }

      final leftChar = s[left];
      if (need.containsKey(leftChar)) {
        if (have[leftChar] == need[leftChar]) missing++;
        have[leftChar] = have[leftChar]! - 1;
      }
      left++;
    }
  }

  if (bestLen == (1 << 30)) return '';
  return s.substring(bestLeft, bestLeft + bestLen);
}

void main() {
  // Примеры из условия.
  void check(String s, String t, String expected) {
    final got = minWindow(s, t);
    final ok = got == expected;
    print('minWindow("$s", "$t") = "$got"'
        '${ok ? ' ✓' : ' ✗ (ожидалось "$expected")'}');
  }

  check('ADOBECODEBANC', 'ABC', 'BANC');
  check('a', 'a', 'a');
  check('a', 'aa', '');
  check('a', '', '');
  check('', 'a', '');
}
