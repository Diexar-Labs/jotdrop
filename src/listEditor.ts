const LIST_MARKER = /^([ \t]*)([-*+])[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/;

function nextFence(line: string, fence: string | null): string | null {
  const match = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
  if (!match) return fence;
  if (!fence) return match[1];
  return match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()
    ? null : fence;
}

/** A single replacement, so Enter remains one undoable native text edit. */
export function listEnterEdit(value: string, start: number, end = start): {
  from: number; to: number; insert: string;
} | null {
  const lineStart = value.slice(0, start).lastIndexOf("\n") + 1;
  const nextNewline = value.indexOf("\n", start);
  const lineEnd = nextNewline < 0 ? value.length : nextNewline;
  const line = value.slice(lineStart, lineEnd);
  const marker = line.match(LIST_MARKER);
  if (!marker || start < lineStart + marker[0].length || end > lineEnd) return null;
  let fence: string | null = null;
  for (const previous of value.slice(0, lineStart).split("\n")) fence = nextFence(previous, fence);
  if (fence) return null;
  const remaining = value.slice(lineStart + marker[0].length, start) + value.slice(end, lineEnd);
  if (!remaining.trim()) return { from: lineStart, to: lineEnd, insert: "" };
  return { from: start, to: end, insert: `\n${marker[1]}- ${marker[3] === undefined ? "" : "[ ] "}` };
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
  const keydown = (event: KeyboardEvent) => {
    plainEnter = event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey);
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
    ta.setSelectionRange(edit.from, edit.to);
    if (!doc.execCommand("insertText", false, edit.insert)) {
      ta.setRangeText(edit.insert, edit.from, edit.to, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
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
