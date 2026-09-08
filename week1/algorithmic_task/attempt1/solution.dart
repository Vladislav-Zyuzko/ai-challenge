/// Находит минимальную подстроку строки [s], содержащую все символы
/// строки [t] с учётом кратности.
///
/// Если такой подстроки не существует, возвращает пустую строку "".
///
/// Сложность: O(|s| + |t|) по времени, O(|s| + |t|) по памяти —
/// классический алгоритм «скользящего окна» с двумя указателями.
String minWindow(String s, String t) {
  // Пустой шаблон: минимальное окно — пустая строка.
  if (t.isEmpty) return '';

  // Строка s физически не может вместить все символы t.
  if (s.length < t.length) return '';

  // Требуемое число вхождений каждого кодового пункта (runes) из t.
  final need = <int, int>{};
  for (final ch in t.runes) {
    need[ch] = (need[ch] ?? 0) + 1;
  }

  // Раскладываем s на кодовые пункты и запоминаем смещение каждого из них
  // в исходной строке (в UTF-16 code units) — это нужно, чтобы корректно
  // выделить итоговую подстроку через s.substring(...).
  final points = <int>[];
  final offsets = <int>[];
  var pos = 0;
  for (final ch in s.runes) {
    points.add(ch);
    offsets.add(pos);
    // Кодовый пункт вне BMP занимает суррогатную пару (2 code units).
    pos += ch > 0xFFFF ? 2 : 1;
  }

  // formed — сколько различных символов из t уже полностью покрыто окном.
  var formed = 0;
  final window = <int, int>{};

  var bestStart = 0;
  var bestLength = -1; // -1 означает, что подходящее окно пока не найдено.
  var left = 0;

  for (var right = 0; right < points.length; right++) {
    final ch = points[right];
    if (need.containsKey(ch)) {
      window[ch] = (window[ch] ?? 0) + 1;
      if (window[ch] == need[ch]) formed++;
    }

    // Пока окно содержит все нужные символы — пробуем сжимать его слева,
    // запоминая самое короткое из валидных окон.
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

void main() {
  bool check(String s, String t, String expected) {
    final result = minWindow(s, t);
    final ok = result == expected;
    print('${ok ? 'PASS' : 'FAIL'}  minWindow("$s", "$t")'
        '${ok ? '' : '  -> "$result", expected "$expected"'}');
    return ok;
  }

  var allOk = true;
  allOk &= check('ADOBECODEBANC', 'ABC', 'BANC'); // Пример 1
  allOk &= check('a', 'a', 'a');                  // Пример 2
  allOk &= check('a', 'aa', '');                  // Пример 3
  allOk &= check('', 'a', '');                    // пустая s
  allOk &= check('abc', '', '');                  // пустой t
  allOk &= check('aa', 'aa', 'aa');               // вся строка целиком
  allOk &= check('aa', 'a', 'a');                 // кратность без повторов
  allOk &= check('abc', 'cba', 'abc');            // обратный порядок
  allOk &= check('bba', 'ab', 'ba');
  allOk &= check('cabwefgewcwaefgcf', 'cae', 'cwae');
  allOk &= check('abca', 'bc', 'bc');
  allOk &= check('aabdec', 'abc', 'abdec');
  allOk &= check('abdbca', 'abc', 'bca');
  allOk &= check('😀😁😂', '😁', '😁');            // астральные символы
  allOk &= check('x😀y😁z', '😀😁', '😀y😁');       // юникод вне BMP

  print(allOk ? '\nALL TESTS PASSED' : '\nSOME TESTS FAILED');
}
