# Haiku 4.5 — 2D Fenwick Tree

## Идея решения

2D Fenwick Tree (Binary Indexed Tree) - это структура данных, которая использует двумерный массив `tree[i][j]` (с индексами 1-based) для хранения информации о префиксных суммах. Каждый элемент `tree[i][j]` содержит сумму элементов в некотором прямоугольнике, размер которого зависит от младших единичных битов `i` и `j`.

Для обновления используется прибавление разницы (newValue - oldValue) к соответствующим элементам дерева, пробегая через позиции с использованием операции `i & (-i)` для перехода к следующей позиции.

Для запроса суммы в прямоугольнике используется формула включения-исключения:
```
query(r1, c1, r2, c2) = prefixSum(r2, c2) 
                        - prefixSum(r1-1, c2) 
                        - prefixSum(r2, c1-1) 
                        + prefixSum(r1-1, c1-1)
```

Где `prefixSum(r, c)` вычисляет сумму всех элементов от (0, 0) до (r, c).

## Реализация

```dart
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
```

## Сложность

- **Конструктор**: O(M × N × log(M) × log(N)) - для каждого из M×N элементов выполняется _add, который работает за O(log(M) × log(N))
- **update**: O(log(M) × log(N)) - обновление дерева требует проходов через высоты обоих измерений
- **query**: O(log(M) × log(N)) - вычисление четырех префиксных сумм, каждая из которых работает за O(log(M) × log(N))

Пространство памяти: O(M × N) для хранения исходной матрицы и дерева Fenwick.

## Пример использования

```dart
void main() {
  final matrix = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9]
  ];
  
  final fw = Fenwick2D(matrix);
  
  // Запрос суммы всех элементов: 1+2+3+4+5+6+7+8+9 = 45
  print(fw.query(0, 0, 2, 2)); // 45
  
  // Обновляем элемент (1, 1) со значения 5 на 10
  fw.update(1, 1, 10);
  
  // Новая сумма всех элементов: 1+2+3+4+10+6+7+8+9 = 50
  print(fw.query(0, 0, 2, 2)); // 50
  
  // Запрос суммы подпрямоугольника от (0, 1) до (2, 2):
  // Элементы: 2, 3 (row 0), 10, 6 (row 1), 8, 9 (row 2)
  // Сумма = 2 + 3 + 10 + 6 + 8 + 9 = 38
  print(fw.query(0, 1, 2, 2)); // 38
}
```

Класс Fenwick2D полностью самодостаточен и может компилироваться как отдельная библиотека Dart без функции main.
