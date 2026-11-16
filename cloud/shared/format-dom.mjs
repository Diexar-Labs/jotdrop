// Tables drawn from the formatting core (format.mjs), for the web app, Obsidian and Joplin. Built with
// createElement and textContent only: what a note says never becomes markup.
import { cellText } from './format.mjs';

// On a card a table is small (16 Nov 2026, Eric's decision): 3 columns, the header and 3 rows, the rest in words.
export const CARD_COLUMNS = 3;
export const CARD_ROWS = 3;

/** "+ 5 columns · + 12 rows", only the parts that are not zero. */
export function moreLabel(columns, rows) {
  /** @type {string[]} */
  const parts = [];
  if (columns > 0) parts.push(`+ ${columns} ${columns === 1 ? 'column' : 'columns'}`);
  if (rows > 0) parts.push(`+ ${rows} ${rows === 1 ? 'row' : 'rows'}`);
  return parts.join(' · ');
}

function tableElement(doc, table, columns, rows, fill) {
  const element = doc.createElement('table');
  const head = doc.createElement('thead'), body = doc.createElement('tbody');
  const row = (cells, tag) => {
    const tr = doc.createElement('tr');
    cells.slice(0, columns).forEach((source, i) => {
      const cell = doc.createElement(tag);
      if (table.align[i]) cell.className = `jd-align-${table.align[i]}`;
      fill(cell, source);
      tr.append(cell);
    });
    return tr;
  };
  head.append(row(table.header, 'th'));
  for (const cells of table.rows.slice(0, rows)) body.append(row(cells, 'td'));
  element.append(head, body);
  return element;
}

/**
 * A table on a card: one line of plain text per cell (CSS ends a long one with "…"), and below it what is left out.
 * `plain` turns a cell's text into what the card shows, without Markdown signs; `more` words the rest.
 */
export function cardTable(doc, table, { plain = (text) => text, more = moreLabel } = {}) {
  const box = doc.createElement('div');
  box.className = 'jd-table jd-card-table';
  box.append(tableElement(doc, table, CARD_COLUMNS, CARD_ROWS, (cell, source) => {
    cell.textContent = plain(cellText(source)).replace(/\s+/g, ' ').trim();
  }));
  const label = more(Math.max(0, table.header.length - CARD_COLUMNS), Math.max(0, table.rows.length - CARD_ROWS));
  if (label) {
    const note = doc.createElement('p');
    note.className = 'jd-table-more';
    note.textContent = label;
    box.append(note);
  }
  return box;
}

/** A whole table to read, scrolling sideways inside its own frame; a `<br>` in a cell is a line break. */
export function noteTable(doc, table, { text = (value) => value, label = 'Table' } = {}) {
  const box = doc.createElement('div');
  box.className = 'jd-table jd-note-table';
  // Keyboard users can scroll a wide table too.
  box.tabIndex = 0;
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', label);
  box.append(tableElement(doc, table, Infinity, Infinity, (cell, source) => {
    text(cellText(source)).split('\n').forEach((part, i) => {
      if (i) cell.append(doc.createElement('br'));
      cell.append(doc.createTextNode(part));
    });
  }));
  return box;
}
