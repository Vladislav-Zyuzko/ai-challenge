// Код извлечён ДОСЛОВНО из ../opus_5.md (модель Opus 5).
// Изменений нет, добавлен только этот комментарий.

/// Двумерное дерево Фенвика: точечное присваивание и сумма по прямоугольнику.
///
/// Публичный API 0-based, внутреннее дерево 1-based.
/// Построение: O(M*N). update: O(log M * log N). query: O(log M * log N).
/// Память: O(M*N).
class Fenwick2D {
  final int _rows;
  final int _cols;

  /// Актуальные значения матрицы — нужны, чтобы update умел присваивать,
  /// а не только прибавлять.
  final List<List<int>> _values;

  /// Дерево частичных сумм, индексы 1..rows / 1..cols.
  final List<List<int>> _tree;

  Fenwick2D(List<List<int>> matrix)
      : _rows = matrix.length,
        _cols = matrix.isEmpty ? 0 : matrix.first.length,
        _values = [for (final row in matrix) List<int>.of(row)],
        _tree = List.generate(
          matrix.length + 1,
          (_) => List<int>.filled(
            (matrix.isEmpty ? 0 : matrix.first.length) + 1,
            0,
          ),
          growable: false,
        ) {
    for (final row in matrix) {
      if (row.length != _cols) {
        throw ArgumentError('Матрица должна быть прямоугольной');
      }
    }
    _build();
  }

  int get rows => _rows;
  int get cols => _cols;

  /// Заменяет значение в ячейке (row, col) на newValue.
  void update(int row, int col, int newValue) {
    _checkCell(row, col);
    final delta = newValue - _values[row][col];
    if (delta == 0) return;
    _values[row][col] = newValue;

    for (var i = row + 1; i <= _rows; i += i & -i) {
      final treeRow = _tree[i];
      for (var j = col + 1; j <= _cols; j += j & -j) {
        treeRow[j] += delta;
      }
    }
  }

  /// Сумма элементов прямоугольника (row1, col1)..(row2, col2) включительно.
  int query(int row1, int col1, int row2, int col2) {
    _checkCell(row1, col1);
    _checkCell(row2, col2);
    if (row1 > row2 || col1 > col2) {
      throw RangeError('Ожидается row1 <= row2 и col1 <= col2');
    }

    return _prefix(row2 + 1, col2 + 1) -
        _prefix(row1, col2 + 1) -
        _prefix(row2 + 1, col1) +
        _prefix(row1, col1);
  }

  /// Текущее значение ячейки — удобно для отладки и тестов.
  int valueAt(int row, int col) {
    _checkCell(row, col);
    return _values[row][col];
  }

  /// Линейное построение: сначала по столбцам внутри каждой строки,
  /// затем по строкам. Порядок проходов важен, объединять их нельзя.
  void _build() {
    for (var i = 1; i <= _rows; i++) {
      final treeRow = _tree[i];
      final sourceRow = _values[i - 1];
      for (var j = 1; j <= _cols; j++) {
        treeRow[j] += sourceRow[j - 1];
        final parent = j + (j & -j);
        if (parent <= _cols) treeRow[parent] += treeRow[j];
      }
    }

    for (var i = 1; i <= _rows; i++) {
      final parent = i + (i & -i);
      if (parent > _rows) continue;
      final from = _tree[i];
      final to = _tree[parent];
      for (var j = 1; j <= _cols; j++) {
        to[j] += from[j];
      }
    }
  }

  /// Сумма подматрицы [0..r) x [0..c) в 1-based координатах дерева.
  int _prefix(int r, int c) {
    var sum = 0;
    for (var i = r; i > 0; i -= i & -i) {
      final treeRow = _tree[i];
      for (var j = c; j > 0; j -= j & -j) {
        sum += treeRow[j];
      }
    }
    return sum;
  }

  void _checkCell(int row, int col) {
    if (row < 0 || row >= _rows) {
      throw RangeError.index(row, _values, 'row', 'Строка вне диапазона');
    }
    if (col < 0 || col >= _cols) {
      throw RangeError.index(col, _values.first, 'col', 'Столбец вне диапазона');
    }
  }
}
