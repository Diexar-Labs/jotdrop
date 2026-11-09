// The tools Ask JotDrop can use, version 1. One list for every app: tools.json holds the same for Android, and a
// test keeps the two equal. mode says what happens when the AI calls it: read (JotDrop answers from the notes on
// this device), create (a new note, made at once; it can go to the bin), confirm (a change to a note the user
// already has: the user sees it first and can say no). There is no tool to delete, archive, share or send.

const id = { type: 'string', description: 'The id of the note, from <note id="..."> or from search_notes.' };
const COLORS = ['default', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'gray'];
const items = { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 200, description: 'Checklist items, one task each, without "- [ ]".' };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS = [
  {
    name: 'search_notes',
    mode: 'read',
    description: "Search the user's notes on this device. Returns id, title, the first characters, labels and date of the best matches.",
    input_schema: object({ query: { type: 'string', maxLength: 200, description: 'Words to look for.' }, limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many notes; 10 when left out.' } }, ['query']),
  },
  {
    name: 'read_note',
    mode: 'read',
    description: 'Read the full text of one note.',
    input_schema: object({ id }, ['id']),
  },
  {
    name: 'create_note',
    mode: 'create',
    description: 'Make a new note. Give text, checklist items, or both.',
    input_schema: object({
      title: { type: 'string', maxLength: 200 },
      text: { type: 'string', maxLength: 20000 },
      items,
      color: { type: 'string', enum: COLORS, description: 'Card color; green shows as cream, teal as slate blue.' },
      label: { type: 'string', maxLength: 100, description: "One of the user's existing labels." },
    }, ['title']),
  },
  {
    name: 'append_to_note',
    mode: 'confirm',
    description: 'Add text or checklist items at the end of a note. The user sees the change and confirms first.',
    input_schema: object({ id, text: { type: 'string', maxLength: 20000 }, items }, ['id']),
  },
  {
    name: 'replace_note_text',
    mode: 'confirm',
    description: 'Replace the whole text of a note, for example to rewrite or sort it. The user sees old and new and confirms first.',
    input_schema: object({ id, text: { type: 'string', maxLength: 20000 } }, ['id', 'text']),
  },
  {
    name: 'set_labels',
    mode: 'confirm',
    description: "Set the labels of a note. Use the user's existing labels; a new label only when the user named it. The user confirms first.",
    input_schema: object({ id, labels: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20 } }, ['id', 'labels']),
  },
  {
    name: 'set_reminder',
    mode: 'confirm',
    description: "Set a reminder on a note, at a date and time in the user's time zone. The user confirms first.",
    input_schema: object({ id, at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', description: 'Local date and time, like 2026-11-10T10:00.' } }, ['id', 'at']),
  },
  {
    name: 'set_expiry',
    mode: 'confirm',
    description: 'Set the date a note expires, for receipts, warranties and documents in the Paper drawer. The user confirms first.',
    input_schema: object({ id, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Like 2028-11-09.' }, drawer: { type: 'string', maxLength: 100, description: 'A Paper drawer section, only when the user named one.' } }, ['id', 'date']),
  },
  {
    name: 'open_note',
    mode: 'read',
    description: 'Open a note on screen for the user.',
    input_schema: object({ id }, ['id']),
  },
];

export const toolByName = (name) => TOOLS.find((tool) => tool.name === name);

// Enough JSON Schema for the catalogue above: objects, strings, integers and arrays of strings.
function check(schema, value, path) {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    for (const key of schema.required ?? []) if (value[key] === undefined) return `${path}.${key} is missing`;
    for (const key of Object.keys(value)) {
      // Own keys only: `constructor` or `__proto__` must not pass as a property of Object.prototype.
      if (!Object.hasOwn(schema.properties, key)) return `${path}.${key} is not allowed`;
      const problem = check(schema.properties[key], value[key], `${path}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be a list`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has more than ${schema.maxItems} items`;
    for (const [i, item] of value.entries()) { const problem = check(schema.items, item, `${path}[${i}]`); if (problem) return problem; }
    return null;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${path} must be a whole number`;
    if (value < schema.minimum || value > schema.maximum) return `${path} must be from ${schema.minimum} to ${schema.maximum}`;
    return null;
  }
  if (typeof value !== 'string') return `${path} must be text`;
  if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${path} does not have the right form`;
  return null;
}

/** null when the input fits the tool's schema, otherwise what is wrong, in words the AI can act on. */
export const validateInput = (tool, input) => check(tool.input_schema, input, 'input');
