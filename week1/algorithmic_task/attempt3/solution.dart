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

// -------- test harness --------

bool covers(String window, String t) {
  final need = <String, int>{};
  for (var i = 0; i < t.length; i++) {
    need[t[i]] = (need[t[i]] ?? 0) + 1;
  }
  final have = <String, int>{};
  for (var i = 0; i < window.length; i++) {
    have[window[i]] = (have[window[i]] ?? 0) + 1;
  }
  for (final e in need.entries) {
    if ((have[e.key] ?? 0) < e.value) return false;
  }
  return true;
}

// brute-force minimal length for s,t
int bruteMinLen(String s, String t) {
  if (t.isEmpty) return 0;
  var best = 1 << 60;
  for (var i = 0; i < s.length; i++) {
    for (var j = i; j < s.length; j++) {
      if (covers(s.substring(i, j + 1), t)) {
        best = best < j - i + 1 ? best : j - i + 1;
      }
    }
  }
  return best == 1 << 60 ? -1 : best; // -1 => none
}

void main() {
  var ok = true;

  void check(String s, String t, String expected, {bool exact = true}) {
    final got = minWindow(s, t);
    final int brute = bruteMinLen(s, t);
    final bool match = brute < 0 ? got.isEmpty : got.length == brute && covers(got, t);
    final expectedOk = !exact || got == expected;
    ok = ok && match && expectedOk;
    print('s=$s t=$t => "$got" (expected "$expected", bruteLen=${brute == -1 ? 'none' : brute}) -> '
        '${match && expectedOk ? 'OK' : 'FAIL'}');
  }

  // Official examples (exact match required)
  check('ADOBECODEBANC', 'ABC', 'BANC');
  check('a', 'a', 'a');
  check('a', 'aa', '');

  // Edge cases (validated by brute force)
  check('', 'a', '', exact: false);
  check('a', '', '', exact: false);
  check('aa', 'aa', 'aa', exact: false);
  check('abc', 'd', '', exact: false);
  check('ADOBECODEBANC', 'ABBC', '', exact: false);
  check('AAAB', 'AB', '', exact: false);
  check('bba', 'ab', '', exact: false);
  check('aaflslflsfsAAB', 'AAB', '', exact: false);
  check('AbcdeF', 'bDF', '', exact: false); // case-sensitive: 'F' vs 'f' differ
  check('aaaaaaaaaa', 'aaa', '', exact: false);
  check('cabwefgewcwaefgcf', 'cae', '', exact: false);

  print(ok ? 'ALL OK' : 'SOME FAILED');
}
