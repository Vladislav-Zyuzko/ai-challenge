// Валидация трёх решений задачи "2D Fenwick Tree" (см. ../input.md).
//
// 10 тестов с краевыми значениями. Каждый тест прогоняется на всех трёх
// реализациях (haiku-4.5, sonnet-5, opus-5), извлечённых дословно из .md.
//
// Запуск:  dart run test/edge_cases.dart
//
// Зависимостей нет: мини-раннер собственный, чтобы прогон был воспроизводим
// офлайн и печатал готовую markdown-таблицу для summary.md.

import 'dart:math';

import '../lib/haiku_4_5.dart' as haiku;
import '../lib/sonnet_5.dart' as sonnet;
import '../lib/opus_5.dart' as opus;

typedef Factory = dynamic Function(List<List<int>> matrix);

final Map<String, Factory> implementations = {
  'haiku-4.5': (m) => haiku.Fenwick2D(m),
  'sonnet-5': (m) => sonnet.Fenwick2D(m),
  'opus-5': (m) => opus.Fenwick2D(m),
};

// --------------------------------------------------------------------------
// Мини-фреймворк
// --------------------------------------------------------------------------

class TestFailure implements Exception {
  final String message;
  TestFailure(this.message);
  @override
  String toString() => message;
}

void check(bool condition, String message) {
  if (!condition) throw TestFailure(message);
}

void expectEq(int actual, int expected, String what) {
  if (actual != expected) {
    throw TestFailure('$what: получено $actual, ожидалось $expected');
  }
}

/// Проверяет, что вызов [body] бросает исключение.
void expectThrows(void Function() body, String what) {
  try {
    body();
  } catch (_) {
    return;
  }
  throw TestFailure('$what: исключение не брошено');
}

/// Проверяет, что вызов [body] НЕ бросает исключение.
void expectNoThrow(void Function() body, String what) {
  try {
    body();
  } catch (e) {
    throw TestFailure('$what: неожиданное исключение $e');
  }
}

class Case {
  final int number;
  final String name;
  final String category; // 'корректность' | 'устойчивость'
  final void Function(Factory make) body;
  Case(this.number, this.name, this.category, this.body);
}

// --------------------------------------------------------------------------
// Эталон: наивная матрица с O(M*N) на запрос
// --------------------------------------------------------------------------

class BruteForce {
  final List<List<int>> a;
  BruteForce(List<List<int>> m) : a = [for (final r in m) List<int>.of(r)];

  void update(int row, int col, int v) => a[row][col] = v;

  int query(int r1, int c1, int r2, int c2) {
    var s = 0;
    for (var i = r1; i <= r2; i++) {
      for (var j = c1; j <= c2; j++) {
        s += a[i][j];
      }
    }
    return s;
  }
}

// --------------------------------------------------------------------------
// 10 тестов
// --------------------------------------------------------------------------

final cases = <Case>[
  // 1 -----------------------------------------------------------------------
  Case(1, 'Пример из условия задачи', 'корректность', (make) {
    final matrix = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    final fw = make(matrix);
    expectEq(fw.query(0, 0, 2, 2) as int, 45, 'сумма всей матрицы');

    fw.update(1, 1, 10);
    expectEq(fw.query(0, 0, 2, 2) as int, 50, 'сумма после update(1,1,10)');

    // В input.md указано 35, но там пропущен элемент (0,2)=3.
    // Прямоугольник строк 0..2 и столбцов 1..2 = 2+3+10+6+8+9 = 38.
    expectEq(fw.query(0, 1, 2, 2) as int, 38, 'query(0,1,2,2)');
  }),

  // 2 -----------------------------------------------------------------------
  Case(2, 'Матрица 1x1: минимальный размер', 'корректность', (make) {
    final fw = make([
      [42]
    ]);
    expectEq(fw.query(0, 0, 0, 0) as int, 42, 'единственная ячейка');

    fw.update(0, 0, -7);
    expectEq(fw.query(0, 0, 0, 0) as int, -7, 'после update на отрицательное');

    fw.update(0, 0, 0);
    expectEq(fw.query(0, 0, 0, 0) as int, 0, 'после обнуления');
  }),

  // 3 -----------------------------------------------------------------------
  Case(3, 'Вырожденные размеры: 1xN и Mx1', 'корректность', (make) {
    // Строка 1 x 10
    final row = make([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    ]);
    expectEq(row.query(0, 0, 0, 9) as int, 55, '1x10: вся строка');
    expectEq(row.query(0, 3, 0, 6) as int, 4 + 5 + 6 + 7, '1x10: срез [3..6]');
    expectEq(row.query(0, 9, 0, 9) as int, 10, '1x10: последняя ячейка');
    row.update(0, 0, 100);
    expectEq(row.query(0, 0, 0, 9) as int, 154, '1x10: после update(0,0,100)');

    // Столбец 10 x 1
    final col = make([
      for (var i = 1; i <= 10; i++) [i]
    ]);
    expectEq(col.query(0, 0, 9, 0) as int, 55, '10x1: весь столбец');
    expectEq(col.query(4, 0, 4, 0) as int, 5, '10x1: одна ячейка');
    col.update(9, 0, -10);
    expectEq(col.query(0, 0, 9, 0) as int, 35, '10x1: после update(9,0,-10)');
  }),

  // 4 -----------------------------------------------------------------------
  Case(4, 'Отрицательные значения и нули', 'корректность', (make) {
    final matrix = [
      [-1, 0, 5],
      [0, -100, 0],
      [3, 0, -2],
    ];
    final fw = make(matrix);
    expectEq(fw.query(0, 0, 2, 2) as int, -95, 'сумма всей матрицы');
    expectEq(fw.query(1, 1, 1, 1) as int, -100, 'одна отрицательная ячейка');
    expectEq(fw.query(0, 0, 1, 1) as int, -101, 'подпрямоугольник 2x2');

    fw.update(1, 1, 100); // с -100 на +100, delta = +200
    expectEq(fw.query(0, 0, 2, 2) as int, 105, 'после смены знака');
    expectEq(fw.query(1, 0, 2, 2) as int, 101, 'нижние две строки');
  }),

  // 5 -----------------------------------------------------------------------
  Case(5, 'Нулевая матрица и update тем же значением (delta == 0)',
      'корректность', (make) {
    final fw = make(List.generate(5, (_) => List.filled(5, 0)));
    expectEq(fw.query(0, 0, 4, 4) as int, 0, 'нулевая матрица целиком');

    // update тем же значением — должен быть no-op, дерево не должно "поехать"
    for (var i = 0; i < 5; i++) {
      for (var j = 0; j < 5; j++) {
        fw.update(i, j, 0);
      }
    }
    expectEq(fw.query(0, 0, 4, 4) as int, 0, 'после 25 no-op update');

    fw.update(2, 2, 7);
    fw.update(2, 2, 7); // повторное присвоение того же значения
    fw.update(2, 2, 7);
    expectEq(fw.query(0, 0, 4, 4) as int, 7,
        'тройное присвоение одного значения не должно множить вклад');
    expectEq(fw.query(2, 2, 2, 2) as int, 7, 'сама ячейка');
    expectEq(fw.query(0, 0, 1, 1) as int, 0, 'соседний прямоугольник');
  }),

  // 6 -----------------------------------------------------------------------
  Case(6, 'Границы LSB: 8x8, 7x5, 1x16, 16x1, 13x9, 17x17 против эталона',
      'корректность', (make) {
    final rnd = Random(20260906); // фиксированный сид — прогон воспроизводим
    final shapes = [
      [8, 8],
      [7, 5],
      [1, 16],
      [16, 1],
      [13, 9],
      [17, 17],
    ];
    for (final shape in shapes) {
      final m = shape[0], n = shape[1];
      final data = List.generate(
          m, (_) => List.generate(n, (_) => rnd.nextInt(2001) - 1000));
      final fw = make(data);
      final ref = BruteForce(data);

      // 200 случайных операций: перемежаем update и query
      for (var op = 0; op < 200; op++) {
        if (op % 3 == 0) {
          final r = rnd.nextInt(m), c = rnd.nextInt(n);
          final v = rnd.nextInt(2001) - 1000;
          fw.update(r, c, v);
          ref.update(r, c, v);
        } else {
          var r1 = rnd.nextInt(m), r2 = rnd.nextInt(m);
          var c1 = rnd.nextInt(n), c2 = rnd.nextInt(n);
          if (r1 > r2) {
            final t = r1;
            r1 = r2;
            r2 = t;
          }
          if (c1 > c2) {
            final t = c1;
            c1 = c2;
            c2 = t;
          }
          expectEq(fw.query(r1, c1, r2, c2) as int, ref.query(r1, c1, r2, c2),
              '${m}x$n query($r1,$c1,$r2,$c2) на шаге $op');
        }
      }
    }
  }),

  // 7 -----------------------------------------------------------------------
  Case(7, 'Вырожденные прямоугольники: углы, строки, столбцы, полный перебор',
      'корректность', (make) {
    final matrix = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ];
    final fw = make(matrix);
    final ref = BruteForce(matrix);

    // Все 4 угла как прямоугольник 1x1
    for (final rc in [
      [0, 0],
      [0, 3],
      [2, 0],
      [2, 3]
    ]) {
      final r = rc[0], c = rc[1];
      expectEq(
          fw.query(r, c, r, c) as int, ref.query(r, c, r, c), 'угол ($r,$c)');
    }
    // Каждая отдельная строка и каждый отдельный столбец
    for (var r = 0; r < 3; r++) {
      expectEq(fw.query(r, 0, r, 3) as int, ref.query(r, 0, r, 3), 'строка $r');
    }
    for (var c = 0; c < 4; c++) {
      expectEq(fw.query(0, c, 2, c) as int, ref.query(0, c, 2, c), 'столбец $c');
    }
    // Исчерпывающий перебор ВСЕХ прямоугольников
    for (var r1 = 0; r1 < 3; r1++) {
      for (var r2 = r1; r2 < 3; r2++) {
        for (var c1 = 0; c1 < 4; c1++) {
          for (var c2 = c1; c2 < 4; c2++) {
            expectEq(fw.query(r1, c1, r2, c2) as int, ref.query(r1, c1, r2, c2),
                'прямоугольник ($r1,$c1)-($r2,$c2)');
          }
        }
      }
    }
  }),

  // 8 -----------------------------------------------------------------------
  Case(8, 'Большие значения на грани int64', 'корректность', (make) {
    const big = 2000000000000000000; // 2e18, 4*big = 8e18 < 2^63-1
    final matrix = [
      [big, big],
      [big, big],
    ];
    final fw = make(matrix);
    expectEq(fw.query(0, 0, 1, 1) as int, 8000000000000000000,
        'сумма четырёх 2e18');

    fw.update(0, 0, -big);
    expectEq(fw.query(0, 0, 1, 1) as int, 4000000000000000000,
        'после смены знака у одной ячейки');
    expectEq(fw.query(0, 0, 0, 0) as int, -big, 'отрицательная ячейка');

    // Границы диапазона int64 в одной ячейке
    final edge = make([
      [9223372036854775807, -9223372036854775808]
    ]);
    expectEq(edge.query(0, 0, 0, 0) as int, 9223372036854775807, 'int64 max');
    expectEq(edge.query(0, 1, 0, 1) as int, -9223372036854775808, 'int64 min');
    expectEq(edge.query(0, 0, 0, 1) as int, -1, 'max + min == -1');
  }),

  // 9 -----------------------------------------------------------------------
  Case(9, 'Независимость от внешней матрицы (защитное копирование)',
      'корректность', (make) {
    final matrix = [
      [1, 2],
      [3, 4],
    ];
    final fw = make(matrix);
    expectEq(fw.query(0, 0, 1, 1) as int, 10, 'исходная сумма');

    // Мутируем ИСХОДНУЮ матрицу после построения дерева.
    matrix[0][0] = 1000;
    matrix[1] = [500, 500];
    expectEq(fw.query(0, 0, 1, 1) as int, 10,
        'внешняя мутация не должна влиять на дерево');

    // И наоборот: update не должен менять исходную матрицу пользователя.
    fw.update(0, 1, 20);
    check(matrix[0][1] == 2,
        'update изменил исходную матрицу пользователя: ${matrix[0][1]}');
    expectEq(fw.query(0, 0, 1, 1) as int, 28, 'сумма после update(0,1,20)');
  }),

  // 10 ----------------------------------------------------------------------
  Case(10, 'Устойчивость: пустая матрица, рваные строки, выход за границы',
      'устойчивость', (make) {
    // (a) пустая матрица — конструктор не должен падать
    expectNoThrow(() => make(<List<int>>[]), 'конструктор от пустой матрицы');

    // (b) рваная матрица, короткая строка идёт второй
    expectThrows(
        () => make([
              [1, 2, 3],
              [4, 5],
            ]),
        'рваная матрица (короткая вторая строка)');

    // (c) рваная матрица, длинная строка идёт второй — элемент молча теряется
    expectThrows(
        () => make([
              [1, 2],
              [3, 4, 5],
            ]),
        'рваная матрица (длинная вторая строка)');

    // (d) выход за границы в update и query
    final fw = make([
      [1, 2],
      [3, 4],
    ]);
    expectThrows(() => fw.update(5, 0, 1), 'update с row вне диапазона');
    expectThrows(() => fw.update(0, -1, 1), 'update с отрицательным col');
    expectThrows(() => fw.query(0, 0, 9, 9), 'query за правой границей');
    expectThrows(() => fw.query(-1, 0, 1, 1), 'query с отрицательным row1');

    // (e) перевёрнутый прямоугольник row1 > row2 — не должен вернуть мусор
    expectThrows(() => fw.query(1, 1, 0, 0), 'query с row1 > row2');
  }),
];

// --------------------------------------------------------------------------
// Раннер
// --------------------------------------------------------------------------

void main() {
  final names = implementations.keys.toList();
  final results = <int, Map<String, String?>>{}; // case -> model -> null|ошибка

  print('=' * 78);
  print('Валидация решений "2D Fenwick Tree": ${names.join(', ')}');
  print('=' * 78);

  for (final c in cases) {
    print('');
    print('[${c.number}] ${c.name}  (${c.category})');
    results[c.number] = {};
    for (final name in names) {
      String? error;
      try {
        c.body(implementations[name]!);
      } on TestFailure catch (e) {
        error = e.message;
      } catch (e) {
        error = 'необработанное исключение: $e';
      }
      results[c.number]![name] = error;
      if (error == null) {
        print('    OK    $name');
      } else {
        print('    FAIL  $name  -> $error');
      }
    }
  }

  // Итоги
  print('');
  print('=' * 78);
  print('ИТОГИ');
  print('=' * 78);

  final passed = {for (final n in names) n: 0};
  final failedCases = {for (final n in names) n: <int>[]};
  for (final c in cases) {
    for (final n in names) {
      if (results[c.number]![n] == null) {
        passed[n] = passed[n]! + 1;
      } else {
        failedCases[n]!.add(c.number);
      }
    }
  }

  // Markdown-таблица для summary.md
  print('');
  print('| # | Тест | Категория | ${names.join(' | ')} |');
  print('|---|------|-----------|${names.map((_) => '---').join('|')}|');
  for (final c in cases) {
    final cells = names
        .map((n) => results[c.number]![n] == null ? 'PASS' : 'FAIL')
        .join(' | ');
    print('| ${c.number} | ${c.name} | ${c.category} | $cells |');
  }
  final totals = names.map((n) => '${passed[n]}/${cases.length}').join(' | ');
  print('| | **Итого** | | $totals |');

  print('');
  for (final n in names) {
    final f = failedCases[n]!;
    print('$n: ${passed[n]}/${cases.length} пройдено'
        '${f.isEmpty ? '' : ', провалены: ${f.join(', ')}'}');
  }

  final anyFailure = names.any((n) => failedCases[n]!.isNotEmpty);
  print('');
  print('Статус прогона: ${anyFailure ? 'есть падения' : 'все тесты зелёные'}');
}
