// Минимальная подстрока, содержащая все символы t (Minimum Window Substring).
//
// Алгоритм: скользящее окно с двумя указателями за O(|s| + |t|).
//
// Инвариант валидности окна — счётчик formed:
//   need    — требуемые кратности символов (мультимножество) из t;
//   have    — кратности символов t в текущем окне;
//   formed  — число РАЗЛИЧНЫХ символов t, для которых окно уже набрало
//             нужную кратность (переход «меньше -> достаточно» инкрементит,
//             обратный переход декрементит; «лишние» копии не влияют).
//   Окно [left, right] валидно, когда formed == need.length.
//
// Единица измерения — кодовая точка Unicode (rune): подсчёт и нарезка
// результата ведутся в одних и тех же единицах, поэтому суррогатные пары
// (не-BMP символы) никогда не разрезаются, а сравнение символов точное
// (без нормализации и приведения регистра). Цена — список код-точек O(|s|);
// по времени по-прежнему O(|s| + |t|).
//
// Конвенции для неоднозначных входов:
//   * пустая t  -> ""  (пустое мультимножество покрыто тривиально);
//   * |t| > |s| -> ""  (окно не может быть короче числа символов t);
//   * нужный символ отсутствует в s -> "" (сканирование просто не находит
//     ни одного валидного окна).
//
// Результат не собирается конкатенацией в цикле: хранится пара индексов,
// подстрока извлекается один раз в конце.

import 'dart:math';

String minWindow(String s, String t) {
  final List<int> tcp = t.runes.toList();
  if (tcp.isEmpty) return '';
  final List<int> scp = s.runes.toList();
  if (scp.length < tcp.length) return '';

  final Map<int, int> need = <int, int>{};
  for (final int c in tcp) {
    need[c] = (need[c] ?? 0) + 1;
  }

  final Map<int, int> have = <int, int>{};
  int formed = 0; // сколько различных символов t уже «покрыто» окном
  int bestL = 0;
  int bestR = 0;
  int bestLen = scp.length + 1; // «бесконечность»
  int left = 0;

  for (int right = 0; right < scp.length; right++) {
    final int c = scp[right];
    final int? req = need[c];
    if (req != null) {
      final int after = (have[c] ?? 0) + 1;
      have[c] = after;
      if (after == req) formed++; // только в момент достижения кратности
    }

    // Окно валидно: сжимаем слева до упора, фиксируя каждого кандидата.
    while (formed == need.length) {
      final int len = right - left + 1;
      if (len < bestLen) {
        bestLen = len;
        bestL = left;
        bestR = right + 1; // правый конец — исключительный
      }
      final int lc = scp[left];
      final int? lreq = need[lc];
      if (lreq != null) {
        final int after = have[lc]! - 1;
        have[lc] = after;
        if (after < lreq) formed--; // кратность сломана — окно невалидно
      }
      left++;
    }
  }

  if (bestLen > scp.length) return '';
  return String.fromCharCodes(scp.sublist(bestL, bestR));
}

// ---------------------------------------------------------------------------
// main(): примеры из условия, краевые случаи и перекрёстная проверка
// против наивного перебора на случайных строках (в т.ч. с не-BMP символами).
// ---------------------------------------------------------------------------

String _q(String x) => '"$x"';

// Покрывает ли окно w мультимножество t (с учётом кратности)?
bool _covers(String w, String t) {
  final Map<int, int> need = <int, int>{};
  for (final int c in t.runes) {
    need[c] = (need[c] ?? 0) + 1;
  }
  final Map<int, int> have = <int, int>{};
  for (final int c in w.runes) {
    if (need.containsKey(c)) have[c] = (have[c] ?? 0) + 1;
  }
  for (final MapEntry<int, int> e in need.entries) {
    if ((have[e.key] ?? 0) < e.value) return false;
  }
  return true;
}

// Наивный эталон: все пары границ, проверка покрытия по частотным картам.
String _bruteMinWindow(String s, String t) {
  final List<int> tcp = t.runes.toList();
  if (tcp.isEmpty) return '';
  final List<int> scp = s.runes.toList();
  if (scp.length < tcp.length) return '';

  final Map<int, int> need = <int, int>{};
  for (final int c in tcp) {
    need[c] = (need[c] ?? 0) + 1;
  }

  int bestL = 0;
  int bestR = 0;
  int bestLen = scp.length + 1;
  for (int l = 0; l < scp.length; l++) {
    final Map<int, int> have = <int, int>{};
    for (int r = l; r < scp.length; r++) {
      final int c = scp[r];
      if (need.containsKey(c)) {
        have[c] = (have[c] ?? 0) + 1;
      }
      bool ok = true;
      for (final MapEntry<int, int> e in need.entries) {
        if ((have[e.key] ?? 0) < e.value) {
          ok = false;
          break;
        }
      }
      if (ok && r - l + 1 < bestLen) {
        bestLen = r - l + 1;
        bestL = l;
        bestR = r + 1;
      }
    }
  }
  if (bestLen > scp.length) return '';
  return String.fromCharCodes(scp.sublist(bestL, bestR));
}

void main() {
  int failures = 0;
  void expect(String s, String t, String expected) {
    final String actual = minWindow(s, t);
    final String label = 'minWindow(${_q(s)}, ${_q(t)})';
    if (actual == expected) {
      print('PASS  $label == ${_q(actual)}');
    } else {
      failures++;
      print('FAIL  $label  expected ${_q(expected)}, got ${_q(actual)}');
    }
  }

  // Для входов с несколькими равнодопустимыми минимумами проверяем свойства:
  // результат — подстрока s, покрывает t, и его длина равна длине минимума
  // по наивному эталону (при равенстве длин допустима любая).
  void expectMinimal(String s, String t) {
    final String actual = minWindow(s, t);
    final String brute = _bruteMinWindow(s, t);
    final String label = 'minWindow(${_q(s)}, ${_q(t)})';
    final bool ok = brute.isEmpty
        ? actual.isEmpty
        : s.contains(actual) &&
            actual.length == brute.length &&
            _covers(actual, t);
    if (ok) {
      print('PASS  $label == ${_q(actual)} '
          '(minimal, length ${brute.length})');
    } else {
      failures++;
      print('FAIL  $label  expected a minimal covering substring of '
          'length ${brute.length}, got ${_q(actual)}');
    }
  }

  // Примеры из условия.
  expect('ADOBECODEBANC', 'ABC', 'BANC');
  expect('a', 'a', 'a');
  expect('a', 'aa', '');

  // Краевые случаи, на которых тонут типовые решения.
  expect('', '', ''); // пустая t -> ""
  expect('abc', '', ''); // пустая t -> ""
  expect('', 'a', '');
  expect('abc', 'abcd', ''); // t длиннее s
  expect('a', 'b', ''); // символ отсутствует
  expect('a', 'A', ''); // регистр: сравнение точное
  expect('aaab', 'aa', 'aa'); // дубликаты: минимум — не первый и не весь s
  expect('aabb', 'aa', 'aa');
  expect('bba', 'ab', 'ba'); // ответ прижат к правому краю
  expect('xxABCxxxxx', 'ABC', 'ABC'); // мусор вокруг
  expect('ADOBECODEBANC', 'AABC', 'ADOBECODEBA'); // двойная A (минимум уникален)
  expect('s', 's', 's'); // s == t (длина 1)
  expect('qwerty', 'qwerty', 'qwerty'); // s == t
  expect('bca', 'abc', 'bca'); // окно = весь s
  expect('zabczz', 'abc', 'abc');
  expect('xyzabcyz', 'abc', 'abc');
  expect('😀a', 'a', 'a'); // не-BMP символ не разрезается
  expect('a😀', '😀', '😀');
  expect('😀😀', '😀', '😀'); // дубликаты пар
  expect('éa', 'é', 'é'); // не-ASCII BMP символ

  // Несколько равнодопустимых минимумов — сверяем с эталоном.
  expectMinimal('ABAACBAB', 'ABC'); // первое валидное окно не минимально
  expectMinimal('cabca', 'abc'); // повторяющийся паттерн
  expectMinimal('ADOBECODEBANC', 'ABC');

  // Перекрёстная проверка с наивным перебором на случайных строках.
  final Random rnd = Random(20240607);
  const List<int> asciiAlphabet = <int>[97, 98, 99]; // a, b, c
  const List<int> unicodeAlphabet = <int>[97, 128512, 233]; // a, 😀, é
  int fuzzFailures = 0;
  for (int iter = 0; iter < 4000; iter++) {
    final bool withUnicode = iter >= 2000;
    final List<int> pool = withUnicode ? unicodeAlphabet : asciiAlphabet;
    String randStr(int maxLen) {
      final int n = rnd.nextInt(maxLen);
      final StringBuffer sb = StringBuffer();
      for (int i = 0; i < n; i++) {
        sb.writeCharCode(pool[rnd.nextInt(pool.length)]);
      }
      return sb.toString();
    }

    final String s = randStr(12);
    final String t = randStr(6);
    final String expected = _bruteMinWindow(s, t);
    final String actual = minWindow(s, t);
    if (expected != actual) {
      fuzzFailures++;
      if (fuzzFailures <= 5) {
        print('FUZZ-FAIL  s=${_q(s)} t=${_q(t)}  '
            'expected ${_q(expected)}, got ${_q(actual)}');
      }
    }
  }
  print('fuzz: 4000 cases, '
      '${fuzzFailures == 0 ? 'all OK' : '$fuzzFailures FAILURES'}');
  failures += fuzzFailures;

  if (failures == 0) {
    print('ALL TESTS PASSED');
  } else {
    print('$failures TEST(S) FAILED');
  }
}
