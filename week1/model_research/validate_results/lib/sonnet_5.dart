// Код извлечён ДОСЛОВНО из ../sonnet_5.md (модель Sonnet 5).
// Изменений нет, добавлен только этот комментарий.

class Fenwick2D {
  final int rows;
  final int cols;
  final List<List<int>> _tree;   // 1-indexed BIT, размер (rows+1) x (cols+1)
  final List<List<int>> _values; // копия текущей матрицы для вычисления delta

  Fenwick2D(List<List<int>> matrix)
      : rows = matrix.length,
        cols = matrix.isEmpty ? 0 : matrix[0].length,
        _tree = List.generate(
          matrix.length + 1,
          (_) => List<int>.filled(
              matrix.isEmpty ? 1 : matrix[0].length + 1, 0),
        ),
        _values = List.generate(
          matrix.length,
          (i) => List<int>.from(matrix[i]),
        ) {
    for (var i = 0; i < rows; i++) {
      for (var j = 0; j < cols; j++) {
        _add(i, j, _values[i][j]);
      }
    }
  }

  /// Прибавляет [delta] к ячейке (row, col) — внутренние 0-indexed координаты.
  void _add(int row, int col, int delta) {
    for (var i = row + 1; i <= rows; i += i & (-i)) {
      for (var j = col + 1; j <= cols; j += j & (-j)) {
        _tree[i][j] += delta;
      }
    }
  }

  /// Сумма прямоугольника [0..row-1] x [0..col-1] (row, col — "количество строк/столбцов").
  int _prefixSum(int row, int col) {
    var sum = 0;
    for (var i = row; i > 0; i -= i & (-i)) {
      for (var j = col; j > 0; j -= j & (-j)) {
        sum += _tree[i][j];
      }
    }
    return sum;
  }

  /// Заменяет значение в ячейке (row, col) на newValue. O(log M * log N).
  void update(int row, int col, int newValue) {
    final delta = newValue - _values[row][col];
    if (delta == 0) return;
    _values[row][col] = newValue;
    _add(row, col, delta);
  }

  /// Сумма прямоугольника с углами (row1, col1) и (row2, col2) включительно.
  /// O(log M * log N).
  int query(int row1, int col1, int row2, int col2) {
    return _prefixSum(row2 + 1, col2 + 1) -
        _prefixSum(row1, col2 + 1) -
        _prefixSum(row2 + 1, col1) +
        _prefixSum(row1, col1);
  }
}
