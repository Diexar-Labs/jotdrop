import { checklistEdit, indentEdit, linePrefix, listEnterEdit as coreListEnterEdit, listLevels } from "../cloud/shared/format.mjs";

const LIST_MARKER = /^([ \t]*)([-*+])[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/;
const LIST_KINDS = new Set(["bullet", "ordered", "task"]);

interface TextEdit { from: number; to: number; insert: string; selFrom?: number; selTo?: number }

/** One edit as one native text change, so Ctrl+Z undoes it; then the selection the edit asks for. */
export function applyTextEdit(ta: HTMLTextAreaElement, edit: TextEdit): void {
  ta.setSelectionRange(edit.from, edit.to);
  if (!ta.ownerDocument.execCommand("insertText", false, edit.insert)) {
    ta.setRangeText(edit.insert, edit.from, edit.to, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (edit.selFrom !== undefined) ta.setSelectionRange(edit.selFrom, edit.selTo ?? edit.selFrom);
}

/**
 * The Checklist button, through the shared core (design kaarten-en-lijsten, part 7): a line gets `- [ ] `, a bullet or
 * numbered line a box in place of its sign (the indent stays), a task is ticked or unticked, moving with `move`.
 */
export function toggleChecklistOnTextArea(ta: HTMLTextAreaElement, move: boolean): void {
  ta.focus();
  const edit = checklistEdit(ta.value, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length, move);
  // A tick always changes the text, so the core's answer is a whole replacement or null.
  if (edit) applyTextEdit(ta, edit as TextEdit);
}

/** Whether the selection touches a list line (task, bullet or numbered) outside code and tables. */
function onListLine(value: string, start: number, end: number): boolean {
  const first = value.slice(0, start).split("\n").length - 1, last = value.slice(0, end).split("\n").length - 1;
  return listLevels(value).slice(first, last + 1).some((level: number) => level >= 0);
}

function nextFence(line: string, fence: string | null): string | null {
  const match = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
  if (!match) return fence;
  if (!fence) return match[1];
  return match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()
    ? null : fence;
}

/**
 * Enter in a list line, from the shared core (cloud/shared/format.mjs), so it is the same as on the web and Android:
 * the next item gets the same sign (a bullet, the next number, an empty box), an empty item in a level goes one level
 * back, and an empty item on level 0 loses its sign. A single replacement, so Enter stays one undoable native edit.
 * On other lines this is an ordinary Enter: the raw text box does not carry formatting signs to the next line.
 */
export function listEnterEdit(value: string, start: number, end = start): TextEdit | null {
  const lineStart = value.slice(0, start).lastIndexOf("\n") + 1;
  const nextNewline = value.indexOf("\n", start);
  if (!LIST_KINDS.has(linePrefix(value.slice(lineStart, nextNewline < 0 ? value.length : nextNewline)).kind)) return null;
  return coreListEnterEdit(value, start, end);
}

/** Keep native textarea selection/IME, with a visual-only bullet layer underneath. */
export function enhanceListEditing(ta: HTMLTextAreaElement): () => void {
  const doc = ta.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "jotdrop-list-editor";
  ta.before(wrapper);
  const preview = doc.createElement("div");
  preview.className = "jotdrop-list-editor-preview";
  preview.setAttribute("aria-hidden", "true");
  wrapper.append(preview, ta);
  const syncScroll = () => {
    preview.scrollTop = ta.scrollTop;
    preview.scrollLeft = ta.scrollLeft;
  };
  const sync = () => {
    preview.replaceChildren();
    let fence: string | null = null;
    const lines = ta.value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const marker = !fence ? line.match(LIST_MARKER) : null;
      if (marker && marker[3] === undefined) {
        preview.append(doc.createTextNode(marker[1]));
        const bullet = doc.createElement("span");
        bullet.className = "jotdrop-list-bullet";
        // Preserve the source marker's width, keeping wrapping and caret positions exact.
        bullet.textContent = marker[2];
        preview.append(bullet, doc.createTextNode(line.slice(marker[1].length + 1)));
      } else {
        preview.append(doc.createTextNode(line));
      }
      if (i < lines.length - 1) preview.append(doc.createTextNode("\n"));
      fence = nextFence(line, fence);
    }
    preview.append(doc.createTextNode("\u200b"));
    preview.style.width = `${ta.clientWidth}px`;
    preview.style.height = `${ta.clientHeight}px`;
    syncScroll();
  };
  let plainEnter = false;
  // Tab and Shift+Tab on a list line change the item's level; elsewhere, and after Ctrl+M, Tab leaves the box.
  let tabLeaves = false;
  const keydown = (event: KeyboardEvent) => {
    plainEnter = event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey);
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      tabLeaves = !tabLeaves;
      return;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey || tabLeaves || event.isComposing) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    const edit = indentEdit(ta.value, start, end, event.shiftKey ? "out" : "in");
    if (!edit && !onListLine(ta.value, start, end)) return;
    event.preventDefault();
    if (edit) applyTextEdit(ta, edit);
  };
  const keyup = () => { plainEnter = false; };
  const beforeInput = (event: InputEvent) => {
    const skip = plainEnter;
    plainEnter = false;
    if (skip || event.defaultPrevented || event.isComposing || !event.cancelable ||
      (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph")) return;
    const edit = listEnterEdit(ta.value, ta.selectionStart, ta.selectionEnd);
    if (!edit) return;
    event.preventDefault();
    applyTextEdit(ta, edit);
  };
  ta.addEventListener("input", sync);
  ta.addEventListener("scroll", syncScroll);
  ta.addEventListener("keydown", keydown);
  ta.addEventListener("keyup", keyup);
  ta.addEventListener("beforeinput", beforeInput);
  const observer = new ResizeObserver(sync);
  observer.observe(ta);
  sync();
  return () => {
    observer.disconnect();
    ta.removeEventListener("input", sync);
    ta.removeEventListener("scroll", syncScroll);
    ta.removeEventListener("keydown", keydown);
    ta.removeEventListener("keyup", keyup);
    ta.removeEventListener("beforeinput", beforeInput);
    wrapper.replaceWith(ta);
  };
}
