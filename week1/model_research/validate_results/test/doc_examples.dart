// Прогон блоков "Пример использования" ДОСЛОВНО из каждого .md,
// чтобы сверить фактический вывод с комментариями, которые модель написала
// рядом со своим кодом.
//
// Запуск: dart run test/doc_examples.dart

import '../lib/haiku_4_5.dart' as haiku;
import '../lib/sonnet_5.dart' as sonnet;
import '../lib/opus_5.dart' as opus;

typedef Factory = dynamic Function(List<List<int>> matrix);

/// Что модель обещала в комментариях к своему примеру.
final claimed = {
  'haiku-4.5': ['45', '50', '38'],
  'sonnet-5': ['45', '50', '38'],
  'opus-5': ['45', '50', '38'],
};

final impls = <String, Factory>{
  'haiku-4.5': (m) => haiku.Fenwick2D(m),
  'sonnet-5': (m) => sonnet.Fenwick2D(m),
  'opus-5': (m) => opus.Fenwick2D(m),
};

void main() {
  print('Пример из input.md, прогнанный на каждой реализации');
  print('=' * 78);
  print('Ожидание по условию: 45, 50, 35 (третье значение — опечатка в '
      'input.md, верно 38)');

  for (final name in impls.keys) {
    final fw = impls[name]!([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    final out = <String>[];
    out.add('${fw.query(0, 0, 2, 2)}');
    fw.update(1, 1, 10);
    out.add('${fw.query(0, 0, 2, 2)}');
    out.add('${fw.query(0, 1, 2, 2)}');

    final promised = claimed[name]!;
    final match = out.join(',') == promised.join(',');
    print('');
    print(name);
    print('    фактический вывод:      ${out.join(', ')}');
    print('    заявлено в комментариях: ${promised.join(', ')}');
    print('    комментарии совпадают:   ${match ? 'да' : 'НЕТ'}');
  }
}
