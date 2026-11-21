// Types for drawing-editor.mjs, for the TypeScript of the Obsidian plugin. The code is drawing-editor.mjs; this file only states the types.

export type DrawingLabels = Record<string, string>;
export type Stroke = { color: string; size: number; points: number[] };
export type DrawingData = { width: number; height: number; strokes: Stroke[] };

export const LABELS: DrawingLabels;
export function createDrawingEditor(options: {
  initial?: DrawingData | null;
  labels?: DrawingLabels;
  confirm?: (text: string) => Promise<boolean>;
  onSave: (result: { png: Uint8Array; drawing: DrawingData }) => Promise<void>;
  onCancel: () => void;
}): {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  close(): Promise<void>;
  readonly dirty: boolean;
  readonly strokes: Stroke[];
};
