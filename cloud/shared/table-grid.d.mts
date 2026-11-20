// Types for table-grid.mjs, for the TypeScript of the Obsidian plugin. The code is table-grid.mjs; this file only states the types.

export type GridTable = { align: string[]; header: string[]; rows: string[][] };
export type GridCell = { row: number; column: number };
export type GridLabels = { table?: string; cell?: (row: number, column: number) => string; typeAbove?: string; typeBelow?: string; [key: string]: unknown };

export function appendInline(doc: Document, parent: HTMLElement, text: string): void;
export function createTableGrid(doc: Document, options: {
  table: GridTable;
  edges?: Record<string, unknown>;
  labels?: GridLabels;
  onEdit?: (op: Record<string, unknown>) => void;
  onFocusCell?: (cell: GridCell) => void;
  onBlurCell?: (cell: GridCell) => void;
  onLeave?: (where: "before" | "after") => void;
  onTypeOutside?: (where: "before" | "after") => void;
}): {
  element: HTMLElement;
  update(next: GridTable, nextEdges?: Record<string, unknown>): void;
  flush(): void;
  focusCell(row: number, column: number): void;
  applyToCell(command: string): void;
  activeCell(): GridCell | null;
  lastCell(): GridCell | null;
  /** Which inline buttons are on for the selection in the open cell. */
  activeFormats(): string[];
  destroy(): void;
};
