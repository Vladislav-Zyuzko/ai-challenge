# 2D Fenwick Tree — Range Sum with Point Updates

## Решение на Dart

### Объяснение подхода

2D Fenwick Tree (Binary Indexed Tree) позволяет эффективно выполнять:
- **point updates** за O(log M × log N)
- **range sum queries** за O(log M × log N)

Ключевые идеи:
1. **2D дерево** хранит префиксные суммы в специальной структуре
2. **Индексирование с 1**: дерево размером (M+1) × (N+1) для удобства
3. **Побитовая операция** `i & (-i)` - получает least significant bit
4. **Включение-исключение** для прямоугольного запроса:
   ```
   sum(r1,c1,r2,c2) = prefixSum(r2,c2) 
                     - prefixSum(r1-1,c2) 
                     - prefixSum(r2,c1-1) 
                     + prefixSum(r1-1,c1-1)
   ```

### Реализация

```dart
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
```

### Пример использования

```dart
void main() {
  final matrix = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9]
  ];

  final fw = Fenwick2D(matrix);
  
  // Запрос суммы всех элементов: 1+2+3+4+5+6+7+8+9 = 45
  print(fw.query(0, 0, 2, 2)); // Output: 45

  // Обновляем (1,1) с 5 на 10
  fw.update(1, 1, 10);
  // Новая сумма: 45 - 5 + 10 = 50
  print(fw.query(0, 0, 2, 2)); // Output: 50

  // Запрос: от (0,1) до (2,2)
  // Элементы: 2 + 3 + 10 + 6 + 8 + 9 = 38
  // (элементы: (0,1)=2, (0,2)=3, (1,1)=10, (1,2)=6, (2,1)=8, (2,2)=9)
  print(fw.query(0, 1, 2, 2)); // Output: 38
}
```

### Анализ сложности

| Операция | Сложность | Память |
|----------|-----------|--------|
| **Инициализация** | O(M × N × log M × log N) | O(M × N) |
| **update** | O(log M × log N) | - |
| **query** | O(log M × log N) | - |

### Как это работает

**_updateTree(row, col, delta)**:
- Начинаем с позиции (row+1, col+1) в дереве (1-индексированное)
- Добавляем delta ко всем ячейкам, которые "зависят" от этой позиции
- Переходим к следующей позиции: `i += i & (-i)` (прибавляем LSB)
- Это гарантирует, что мы обновим все "родительские" узлы в дереве

**_prefixSum(row, col)**:
- Вычисляем сумму всех элементов от (0,0) до (row,col)
- Начинаем с (row+1, col+1) и "спускаемся" вниз по дереву
- Переходим к предыдущей позиции: `i -= i & (-i)` (вычитаем LSB)
- Собираем значения из дерева для получения итоговой суммы

**query(r1, c1, r2, c2)**:
- Используем принцип включения-исключения для 2D
- Похоже на запрос 1D диапазона, но для прямоугольника

### Визуальный пример

Для матрицы 3×3 Fenwick Tree выглядит так (индексирование с 1):

```
tree[1][1] = matrix[0][0]
tree[1][2] = matrix[0][0] + matrix[0][1]
tree[2][1] = matrix[0][0] + matrix[1][0]
tree[2][2] = matrix[0][0] + matrix[0][1] + matrix[1][0] + matrix[1][1]
... и т.д.
```

При обновлении элемента обновляются все узлы, для которых этот элемент является частью их диапазона.
При запросе прямоугольника используется формула включения-исключения для получения результата за логарифмическое время.
