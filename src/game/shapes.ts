export interface Shape {
  name: string;
  cells: Array<[number, number]>;
  bottomWidth: number;
  height: number;
}

function shape(name: string, cells: Array<[number, number]>): Shape {
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  const normalized: Array<[number, number]> = cells.map(([x, y]) => [x - minX, y - minY]);
  
  const bottomCells = normalized.filter(([, y]) => y === 0);
  const bottomWidth = bottomCells.length;
  const height = Math.max(...normalized.map(([, y]) => y)) + 1;
  return { name, cells: normalized, bottomWidth, height };
}

export const SHAPES: Shape[] = [
  // --- Triominoes (3-cell Sector Shards) ---
  shape('i3_horiz', [[0, 0], [1, 0], [2, 0]]),
  shape('l3_corner', [[0, 0], [1, 0], [0, 1]]),
  shape('v3_notch', [[0, 0], [1, 0], [1, 1]]),
  shape('i3_vert', [[0, 0], [0, 1], [0, 2]]),

  // --- Tetrominoes (4-cell Data Cores) ---
  shape('o4_square', [[0, 0], [1, 0], [0, 1], [1, 1]]),
  shape('t4_cross', [[0, 0], [1, 0], [2, 0], [1, 1]]),
  shape('l4_left', [[0, 0], [1, 0], [2, 0], [0, 1]]),
  shape('l4_right', [[0, 0], [1, 0], [2, 0], [2, 1]]),
  shape('j4_vert', [[0, 0], [1, 0], [0, 1], [0, 2]]),
  shape('d4_tower', [[0, 0], [1, 0], [1, 1], [1, 2]]),
  shape('i4_vert', [[0, 0], [0, 1], [0, 2], [0, 3]]),
  shape('i4_horiz', [[0, 0], [1, 0], [2, 0], [3, 0]]),

  // --- Pentominoes & Key Cores (5-cell Sector Artifacts) ---
  shape('u5_channel', [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]]),
  shape('t5_heavy', [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]),
  shape('p5_block', [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]),
  shape('w5_step', [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]]),
  shape('v5_corner', [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]]),
];

export const SHAPES_BY_WIDTH: Record<number, Shape[]> = SHAPES.reduce(
  (acc, s) => {
    (acc[s.bottomWidth] ||= []).push(s);
    return acc;
  },
  {} as Record<number, Shape[]>,
);

