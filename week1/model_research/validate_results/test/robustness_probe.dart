// Диагностика к тесту 10: какие именно проверки устойчивости проходит каждая
// реализация. Тест 10 останавливается на первом падении, здесь — полная картина.
//
// Запуск: dart run test/robustness_probe.dart

import '../lib/haiku_4_5.dart' as haiku;
import '../lib/sonnet_5.dart' as sonnet;
import '../lib/opus_5.dart' as opus;

typedef Factory = dynamic Function(List<List<int>> matrix);

final Map<String, Factory> impls = {
  'haiku-4.5': (m) => haiku.Fenwick2D(m),
  'sonnet-5': (m) => sonnet.Fenwick2D(m),
  'opus-5': (m) => opus.Fenwick2D(m),
};

/// Возвращает 'throws: <Тип>' или 'returns <значение>'.
String probe(Object? Function() body) {
  try {
    final r = body();
    return r == null ? 'без исключения' : 'вернул $r';
  } catch (e) {
    return 'throws ${e.runtimeType}';
  }
}

void main() {
  final checks = <String, Object? Function(Factory)>{
    '(a) конструктор от пустой матрицы []': (make) {
      make(<List<int>>[]);
      return null;
    },
    '(b) рваная: [[1,2,3],[4,5]]': (make) {
      make([
        [1, 2, 3],
        [4, 5]
      ]);
      return null;
    },
    '(c) рваная: [[1,2],[3,4,5]]': (make) {
      final fw = make([
        [1, 2],
        [3, 4, 5]
      ]);
      return 'сумма ${fw.query(0, 0, 1, 1)} вместо 15 (элемент 5 потерян)';
    },
    '(d1) update(5,0,..) вне диапазона': (make) {
      make([
        [1, 2],
        [3, 4]
      ]).update(5, 0, 1);
      return null;
    },
    '(d2) update(0,-1,..) отрицательный col': (make) {
      make([
        [1, 2],
        [3, 4]
      ]).update(0, -1, 1);
      return null;
    },
    '(d3) query(0,0,9,9) за границей': (make) => make([
          [1, 2],
          [3, 4]
        ]).query(0, 0, 9, 9),
    '(d4) query(-1,0,1,1) отрицательный row1': (make) => make([
          [1, 2],
          [3, 4]
        ]).query(-1, 0, 1, 1),
    '(e) query(1,1,0,0) перевёрнутый прямоугольник': (make) => make([
          [1, 2],
          [3, 4]
        ]).query(1, 1, 0, 0),
  };

  print('Диагностика устойчивости (тест 10)');
  print('=' * 78);
  for (final entry in checks.entries) {
    print('');
    print(entry.key);
    for (final name in impls.keys) {
      print('    ${name.padRight(11)} ${probe(() => entry.value(impls[name]!))}');
    }
  }
}
