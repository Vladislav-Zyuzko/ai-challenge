import 'dart:io';
import 'dart:math';
import 'solution.dart' as sol;

bool containsAll(String sub, String t) {
  final need = <String, int>{};
  for (var i = 0; i < t.length; i++) need[t[i]] = (need[t[i]] ?? 0) + 1;
  for (final c in need.keys) {
    var cnt = 0;
    for (var i = 0; i < sub.length; i++) if (sub[i] == c) cnt++;
    if (cnt < need[c]!) return false;
  }
  return true;
}

int bruteLen(String s, String t) {
  if (t.isEmpty) return 0;
  var best = -1;
  for (var i = 0; i < s.length; i++) {
    for (var j = i + 1; j <= s.length; j++) {
      if (containsAll(s.substring(i, j), t)) {
        final len = j - i;
        if (best == -1 || len < best) best = len;
      }
    }
  }
  return best;
}

void main() {
  final rnd = Random(20260903);
  const alpha = 'abc';
  var fails = 0;
  const N = 300;
  for (var it = 0; it < N; it++) {
    final sl = rnd.nextInt(13);
    final tl = rnd.nextInt(5);
    final sb = StringBuffer();
    for (var i = 0; i < sl; i++) sb.write(alpha[rnd.nextInt(alpha.length)]);
    final tb = StringBuffer();
    for (var i = 0; i < tl; i++) tb.write(alpha[rnd.nextInt(alpha.length)]);
    final s = sb.toString();
    final t = tb.toString();
    final expected = bruteLen(s, t);
    final got = sol.minWindow(s, t);
    final ok = (expected == -1 && got == '') ||
        (got.length == expected && containsAll(got, t));
    if (!ok) {
      fails++;
      if (fails <= 5) print('MISMATCH s="$s" t="$t" expectedLen=$expected got="${got.length}":"$got"');
    }
  }
  print('DIFFERENTIAL $fails fails / $N');
  exit(fails == 0 ? 0 : 1);
}
