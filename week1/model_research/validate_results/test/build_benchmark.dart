// Замер времени построения: opus-5 заявляет линейное O(M*N), haiku-4.5 и
// sonnet-5 строят через M*N вызовов update, то есть O(M*N*logM*logN).
// Проверяем, видна ли разница на практике, и что результаты сходятся.
//
// Запуск: dart run test/build_benchmark.dart

import 'dart:math';

import '../lib/haiku_4_5.dart' as haiku;
import '../lib/sonnet_5.dart' as sonnet;
import '../lib/opus_5.dart' as opus;

typedef Factory = dynamic Function(List<List<int>> matrix);

final impls = <String, Factory>{
  'haiku-4.5': (m) => haiku.Fenwick2D(m),
  'sonnet-5': (m) => sonnet.Fenwick2D(m),
  'opus-5': (m) => opus.Fenwick2D(m),
};

void main() {
  const m = 1000, n = 1000;
  final rnd = Random(20260906);
  final data =
      List.generate(m, (_) => List.generate(n, (_) => rnd.nextInt(200) - 100));

  var expected = 0;
  for (final row in data) {
    for (final v in row) {
      expected += v;
    }
  }

  print('Построение дерева на матрице ${m}x$n');
  print('=' * 78);
  print('Эталонная сумма всех элементов: $expected');

  for (final name in impls.keys) {
    // прогрев JIT на маленькой матрице
    impls[name]!(List.generate(50, (_) => List.filled(50, 1)));

    final sw = Stopwatch()..start();
    final fw = impls[name]!(data);
    sw.stop();
    final sum = fw.query(0, 0, m - 1, n - 1) as int;

    final qw = Stopwatch()..start();
    var acc = 0;
    for (var i = 0; i < 100000; i++) {
      acc += fw.query(rnd.nextInt(m ~/ 2), rnd.nextInt(n ~/ 2),
          m ~/ 2 + rnd.nextInt(m ~/ 2), n ~/ 2 + rnd.nextInt(n ~/ 2)) as int;
    }
    qw.stop();

    print('');
    print('${name.padRight(11)} построение: ${sw.elapsedMilliseconds} мс'
        '   100k запросов: ${qw.elapsedMilliseconds} мс');
    print('${' '.padRight(11)} сумма: $sum'
        '  ${sum == expected ? '(совпала)' : '(РАСХОЖДЕНИЕ)'}'
        '   [контроль: $acc]');
  }
}
