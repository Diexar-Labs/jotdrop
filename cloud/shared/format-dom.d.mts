// Types for format-dom.mjs, for the TypeScript of the Obsidian plugin. The code is format-dom.mjs; this file only states the types.
import type { GridTable } from "./table-grid.mjs";

export const CARD_COLUMNS: number;
export const CARD_ROWS: number;
export function moreLabel(columns: number, rows: number): string;
/** A small table for a card: the first columns and rows, and a line for what does not fit. */
export function cardTable(doc: Document, table: GridTable, options?: { plain?: (text: string) => string; more?: (columns: number, rows: number) => string }): HTMLElement;
export function noteTable(doc: Document, table: GridTable, options?: { text?: (value: string) => string; label?: string }): HTMLElement;
