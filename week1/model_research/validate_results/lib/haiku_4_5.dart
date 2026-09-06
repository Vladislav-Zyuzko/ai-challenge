class Fenwick2D {
  late List<List<int>> tree;
  late List<List<int>> matrix;
  late int rows;
  late int cols;
  
  /// Инициализирует Fenwick2D структуру с заданной матрицей
  Fenwick2D(List<List<int>> initialMatrix) {
    matrix = initialMatrix.map((row) => List<int>.from(row)).toList();
    rows = matrix.length;
    cols = rows > 0 ? matrix[0].length : 0;
    
    // Создаем дерево размером (rows+1) x (cols+1) с индексацией 1-based
    tree = List.generate(rows + 1, (_) => List.filled(cols + 1, 0));
    
    // Инициализируем дерево, добавляя все элементы матрицы
    for (int i = 0; i < rows; i++) {
      for (int j = 0; j < cols; j++) {
        _add(i, j, matrix[i][j]);
      }
    }
  }
  
  /// Вспомогательный метод для добавления значения в Fenwick дерево
  /// row и col - это 0-based индексы, которые преобразуются в 1-based для дерева
  void _add(int row, int col, int val) {
    int i = row + 1;  // преобразуем в 1-based индекс
    while (i <= rows) {
      int j = col + 1;  // преобразуем в 1-based индекс
      while (j <= cols) {
        tree[i][j] += val;
        j += j & (-j);  // переход к следующей позиции по j
      }
      i += i & (-i);  // переход к следующей позиции по i
    }
  }
  
  /// Вычисляет префиксную сумму от (0, 0) до (row, col)
  /// row и col - это 0-based индексы
  int _prefixSum(int row, int col) {
    int sum = 0;
    int i = row + 1;  // преобразуем в 1-based индекс
    while (i > 0) {
      int j = col + 1;  // преобразуем в 1-based индекс
      while (j > 0) {
        sum += tree[i][j];
        j -= j & (-j);  // переход к предыдущей позиции по j
      }
      i -= i & (-i);  // переход к предыдущей позиции по i
    }
    return sum;
  }
  
  /// Возвращает сумму элементов в прямоугольнике от (row1, col1) до (row2, col2) включительно
  int query(int row1, int col1, int row2, int col2) {
    int sum = _prefixSum(row2, col2);
    
    if (row1 > 0) {
      sum -= _prefixSum(row1 - 1, col2);
    }
    if (col1 > 0) {
      sum -= _prefixSum(row2, col1 - 1);
    }
    if (row1 > 0 && col1 > 0) {
      sum += _prefixSum(row1 - 1, col1 - 1);
    }
    
    return sum;
  }
  
  /// Заменяет значение в ячейке (row, col) на newValue
  void update(int row, int col, int newValue) {
    int delta = newValue - matrix[row][col];
    matrix[row][col] = newValue;
    _add(row, col, delta);
  }
}
