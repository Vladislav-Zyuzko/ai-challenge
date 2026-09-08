/// Двумерное дерево Фенвика (2D Binary Indexed Tree) для матрицы целых
/// чисел размером M x N. Поддерживает точечное обновление значения ячейки
/// и запрос суммы элементов в произвольном прямоугольнике за
/// O(log M * log N) на операцию.
class Fenwick2D {
  final int rows;
  final int cols;

  // Внутреннее дерево Фенвика, 1-индексированное: размер (rows+1) x (cols+1).
  late final List<List<int>> _tree;

  // Текущие значения матрицы (0-индексированные), нужны, чтобы при update
  // вычислить дельту относительно предыдущего значения ячейки.
  late final List<List<int>> _values;

  Fenwick2D(List<List<int>> matrix)
      : rows = matrix.length,
        cols = matrix.isEmpty ? 0 : matrix[0].length {
    _tree = List.generate(rows + 1, (_) => List<int>.filled(cols + 1, 0));
    _values = List.generate(rows, (r) => List<int>.from(matrix[r]));

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        _add(r, c, _values[r][c]);
      }
    }
  }

  /// Добавляет [delta] к ячейке (row, col) во внутреннем дереве.
  /// row, col — 0-индексированные координаты исходной матрицы.
  void _add(int row, int col, int delta) {
    for (var i = row + 1; i <= rows; i += i & (-i)) {
      for (var j = col + 1; j <= cols; j += j & (-j)) {
        _tree[i][j] += delta;
      }
    }
  }

  /// Сумма прямоугольника [0..row] x [0..col] (0-индексированные,
  /// включительно). Возвращает 0, если row < 0 или col < 0.
  int _prefixSum(int row, int col) {
    if (row < 0 || col < 0) return 0;
    var sum = 0;
    for (var i = row + 1; i > 0; i -= i & (-i)) {
      for (var j = col + 1; j > 0; j -= j & (-j)) {
        sum += _tree[i][j];
      }
    }
    return sum;
  }

  /// Заменяет значение ячейки (row, col) на newValue.
  /// Требуется: 0 <= row < rows, 0 <= col < cols.
  void update(int row, int col, int newValue) {
    final delta = newValue - _values[row][col];
    if (delta == 0) return;
    _values[row][col] = newValue;
    _add(row, col, delta);
  }

  /// Возвращает сумму элементов прямоугольника с верхним левым углом
  /// (row1, col1) и нижним правым углом (row2, col2), включительно.
  /// Требуется: 0 <= row1 <= row2 < rows, 0 <= col1 <= col2 < cols.
  int query(int row1, int col1, int row2, int col2) {
    return _prefixSum(row2, col2) -
        _prefixSum(row1 - 1, col2) -
        _prefixSum(row2, col1 - 1) +
        _prefixSum(row1 - 1, col1 - 1);
  }
}
