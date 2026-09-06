/// Двумерное дерево Фенвика (Binary Indexed Tree).
///
/// Поддерживает точечную замену значения и сумму на произвольном
/// подпрямоугольнике за O(log M * log N).
class Fenwick2D {
  /// Количество строк исходной матрицы.
  final int rows;

  /// Количество столбцов исходной матрицы.
  final int cols;

  /// Дерево Фенвика, 1-based по обеим осям: размер (rows + 1) x (cols + 1).
  final List<List<int>> _tree;

  /// Актуальные значения матрицы — нужны, чтобы вычислять дельту при update.
  final List<List<int>> _vals;

  /// Строит структуру по матрице [matrix] за O(M * N).
  ///
  /// Матрица копируется, поэтому внешние изменения исходного списка
  /// на структуру не влияют.
  Fenwick2D(List<List<int>> matrix)
      : rows = matrix.length,
        cols = matrix.isEmpty ? 0 : matrix[0].length,
        _vals = List<List<int>>.generate(
          matrix.length,
          (i) => List<int>.of(matrix[i]),
          growable: false,
        ),
        _tree = List<List<int>>.generate(
          matrix.length + 1,
          (_) => List<int>.filled(
            (matrix.isEmpty ? 0 : matrix[0].length) + 1,
            0,
          ),
          growable: false,
        ) {
    _build();
  }

  /// Каскадное построение дерева за O(M * N).
  void _build() {
    // 1) Горизонтальный проход: внутри каждой строки собираем 1D-дерево Фенвика.
    for (var i = 1; i <= rows; i++) {
      final treeRow = _tree[i];
      final srcRow = _vals[i - 1];
      for (var j = 1; j <= cols; j++) {
        treeRow[j] += srcRow[j - 1];
        final parent = j + (j & -j);
        if (parent <= cols) {
          treeRow[parent] += treeRow[j];
        }
      }
    }
    // 2) Вертикальный проход: собираем 1D-дерево Фенвика внутри каждого столбца.
    for (var j = 1; j <= cols; j++) {
      for (var i = 1; i <= rows; i++) {
        final parent = i + (i & -i);
        if (parent <= rows) {
          _tree[parent][j] += _tree[i][j];
        }
      }
    }
  }

  /// Заменяет значение в ячейке ([row], [col]) на [newValue].
  ///
  /// Сложность O(log M * log N).
  void update(int row, int col, int newValue) {
    if (row < 0 || row >= rows || col < 0 || col >= cols) {
      throw RangeError('Индекс ($row, $col) вне матрицы ${rows}x$cols');
    }
    final delta = newValue - _vals[row][col];
    if (delta == 0) return;
    _vals[row][col] = newValue;

    for (var i = row + 1; i <= rows; i += i & -i) {
      final treeRow = _tree[i];
      for (var j = col + 1; j <= cols; j += j & -j) {
        treeRow[j] += delta;
      }
    }
  }

  /// Сумма элементов подпрямоугольника с углами ([row1], [col1]) и ([row2], [col2])
  /// включительно.
  ///
  /// Сложность O(log M * log N).
  int query(int row1, int col1, int row2, int col2) {
    if (row1 < 0 || col1 < 0 || row2 >= rows || col2 >= cols) {
      throw RangeError('Прямоугольник ($row1, $col1)-($row2, $col2) '
          'вне матрицы ${rows}x$cols');
    }
    if (row1 > row2 || col1 > col2) return 0;

    return _prefix(row2 + 1, col2 + 1) -
        _prefix(row1, col2 + 1) -
        _prefix(row2 + 1, col1) +
        _prefix(row1, col1);
  }

  /// Текущее значение ячейки ([row], [col]) — O(1).
  int valueAt(int row, int col) => _vals[row][col];

  /// Сумма прямоугольника [0..r-1] x [0..c-1] (границы 1-based, эксклюзивные
  /// в терминах 0-based индексов матрицы).
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
}
