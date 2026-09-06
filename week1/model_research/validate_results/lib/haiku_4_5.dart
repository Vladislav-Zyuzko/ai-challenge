// Код извлечён ДОСЛОВНО из ../haiku_4_5.md (модель Haiku 4.5).
// Изменений нет, добавлен только этот комментарий.

class Fenwick2D {
  late List<List<int>> tree;
  late List<List<int>> matrix;
  late int m;
  late int n;

  /// Инициализация 2D Fenwick Tree
  Fenwick2D(List<List<int>> initialMatrix) {
    this.matrix = initialMatrix.map((row) => [...row]).toList();
    this.m = initialMatrix.length;
    this.n = initialMatrix.isNotEmpty ? initialMatrix[0].length : 0;

    tree = List.generate(m + 1, (_) => List.filled(n + 1, 0));

    // Построение дерева из исходной матрицы
    for (int i = 0; i < m; i++) {
      for (int j = 0; j < n; j++) {
        _updateTree(i, j, initialMatrix[i][j]);
      }
    }
  }

  /// Обновляет значение в позиции (row, col)
  void update(int row, int col, int newValue) {
    int delta = newValue - matrix[row][col];
    matrix[row][col] = newValue;
    _updateTree(row, col, delta);
  }

  /// Возвращает сумму элементов в прямоугольнике от (row1,col1) до (row2,col2)
  int query(int row1, int col1, int row2, int col2) {
    int sum = _prefixSum(row2, col2);
    if (row1 > 0) sum -= _prefixSum(row1 - 1, col2);
    if (col1 > 0) sum -= _prefixSum(row2, col1 - 1);
    if (row1 > 0 && col1 > 0) sum += _prefixSum(row1 - 1, col1 - 1);
    return sum;
  }

  /// Внутренний метод: обновляет дерево на delta в позиции (row, col)
  void _updateTree(int row, int col, int delta) {
    // Проходим по всем ячейкам дерева, которые зависят от (row, col)
    for (int i = row + 1; i <= m; i += i & (-i)) {
      for (int j = col + 1; j <= n; j += j & (-j)) {
        tree[i][j] += delta;
      }
    }
  }

  /// Внутренний метод: вычисляет префиксную сумму от (0,0) до (row,col)
  int _prefixSum(int row, int col) {
    int sum = 0;
    // Проходим вверх и влево по дереву
    for (int i = row + 1; i > 0; i -= i & (-i)) {
      for (int j = col + 1; j > 0; j -= j & (-j)) {
        sum += tree[i][j];
      }
    }
    return sum;
  }
}
