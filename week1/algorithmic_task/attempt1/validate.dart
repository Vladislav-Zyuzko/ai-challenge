import 'dart:io';
import 'solution.dart' as sol;

void main() {
  final cases = <(String, String, String)>[
    ('ADOBECODEBANC', 'ABC', 'BANC'),
    ('a', 'a', 'a'),
    ('a', 'aa', ''),
    ('a', 'b', ''),
    ('aa', 'aa', 'aa'),
    ('bba', 'ab', 'ba'),
    ('abc', 'b', 'b'),
  ];
  var pass = 0;
  for (final c in cases) {
    final got = sol.minWindow(c.$1, c.$2);
    final ok = got == c.$3;
    print('${ok ? "PASS" : "FAIL"}: s="${c.$1}" t="${c.$2}" expected="${c.$3}" got="${got}"');
    if (ok) pass++;
  }
  print('RESULT $pass/${cases.length}');
  exit(pass == cases.length ? 0 : 1);
}
