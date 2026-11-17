// Presentation only: callers retain their own parser, source identities and write path.
//
// Cards follow Google Keep (measured 9 Nov 2026, Eric's decision): a note whose content is only
// tasks is a checklist card with up to 10 open tasks, the ticked ones folded into "+ N checked items".
// A note with tasks and other text is a mixed card (design kaarten-en-lijsten, part 5): its rows in the
// note's own order, tasks with real boxes that tick both ways, ticked ones struck through in place. A note
// without tasks is a text card.
export const MAX_CARD_TASKS = 10;

/** A line with only hashtags is metadata: the tags already show as chips on the card. */
export function tagOnly(text) {
  return /^\s*(?:\\?#[^\s#]+\s*)+$/u.test(String(text || ''));
}

/** True when every content row is a task (and there is at least one). */
export function checklistOnly(rows, isTask, isMeta = () => false) {
  const content = rows.filter((row) => isTask(row) || !isMeta(row));
  return content.length > 0 && content.every(isTask);
}

export function cardPreview(host, rows, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const controls = doc.createElement('div');
  if (!host.id) host.id = `compact-preview-${++previewSequence}`;
  controls.className = 'compact-preview-controls';
  host.after(controls);
  let signature = '', frame = 0, settle = 0, disposed = false, watched = [];
  const isMeta = (row) => !options.isTask(row) && Boolean(options.isMeta?.(row));
  const bottomOf = (node) => node.getBoundingClientRect().bottom - host.getBoundingClientRect().top;
  const fits = (node, limit) => bottomOf(node) <= limit + .5;
  const level = (row) => options.level?.(row) || 0;
  /** A task's text past its own line clamp: the card says "Open note", and a clipped link must not stay focusable. */
  const clampedTask = (node) => {
    const text = node.querySelector('[data-preview-task-text]');
    if (!text || text.scrollHeight <= text.clientHeight + 1) return false;
    for (const link of text.querySelectorAll('a, button, [tabindex]')) link.replaceWith(doc.createTextNode(link.textContent || ''));
    return true;
  };
  /** A text block that only partly fits becomes plain text ending in "…", as long as `ok` holds; false: nothing fits. */
  const clipText = (node, ok) => {
    const chars = Array.from(node.textContent || '');
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      node.textContent = chars.slice(0, mid).join('') + '…';
      if (ok()) low = mid; else high = mid - 1;
    }
    node.textContent = chars.slice(0, low).join('') + '…';
    return ok() && low > 0;
  };
  const measure = () => {
    host.replaceChildren();
    const nodes = [];
    const mode = checklistOnly(rows, options.isTask, options.isMeta) ? 'checklist' : rows.some(options.isTask) ? 'mixed' : 'text';
    if (mode === 'checklist') {
      // Room for 10 one-line tasks; long tasks may still leave some for "Open note - N more tasks".
      const height = Math.max(0, Math.min(480, options.height() * .6));
      host.style.maxHeight = `${height}px`;
      // A ticked task with an open sub-task under it stays, struck through, as the heading of its open sub-tasks.
      const all = rows.filter(options.isTask);
      const heads = new Set(all.filter((row, i) => {
        if (!options.isChecked(row)) return false;
        for (let j = i + 1; j < all.length && level(all[j]) > level(row); j++) if (!options.isChecked(all[j])) return true;
        return false;
      }));
      // A task ticked on the card stays until its stroke is drawn, then joins the checked ones.
      let wait = 0;
      const open = all.filter((row) => {
        if (!options.isChecked(row) || heads.has(row)) return true;
        const left = options.lingering?.(row) || 0;
        wait = Math.max(wait, left);
        return left > 0;
      });
      const checked = all.length - open.length;
      let tasks = 0, clamped = false;
      for (const row of open) {
        if (tasks >= MAX_CARD_TASKS) break;
        const node = options.render(row, false);
        host.append(node);
        if (!fits(node, height)) { node.remove(); break; }
        nodes.push(node);
        tasks++;
        if (clampedTask(node)) clamped = true;
      }
      return { mode, nodes, height, tasks, more: open.length - tasks, checked, wait, hidden: clamped || Boolean(options.truncated) };
    }
    if (mode === 'mixed') {
      // The text keeps the text card's room; up to 10 tasks come on top, the whole card as high as a checklist card.
      const height = Math.max(0, Math.min(480, options.height() * .6));
      const budget = Math.max(0, Math.min(200, options.height() * .4));
      host.style.maxHeight = `${height}px`;
      let tasks = 0, text = 0, shown = 0, above = 0, hidden = false;
      // The card is a window on the start of the note: it ends at the first row that does not fit, never skipping one.
      for (const row of rows) {
        const task = options.isTask(row);
        if (task && tasks >= MAX_CARD_TASKS) break;
        const node = options.render(row, false);
        host.append(node);
        const bottom = bottomOf(node);
        if (task) {
          if (bottom > height + .5) { node.remove(); break; }
          tasks++;
          if (clampedTask(node)) hidden = true;
        } else if (bottom > height + .5 || text + bottom - above > budget + .5) {
          hidden = true;
          // A table is whole or not there.
          if (options.atomic?.(row)) { node.remove(); break; }
          if (clipText(node, () => fits(node, height) && text + bottomOf(node) - above <= budget + .5)) { nodes.push(node); shown++; }
          else node.remove();
          break;
        } else text += bottom - above;
        nodes.push(node);
        shown++;
        above = bottom;
      }
      const more = rows.slice(shown).filter(options.isTask).length;
      return { mode, nodes, height, tasks, more, checked: 0, wait: 0, hidden: hidden || shown < rows.length || Boolean(options.truncated) };
    }
    const height = Math.max(0, Math.min(200, options.height() * .4));
    host.style.maxHeight = `${height}px`;
    let hidden = false, used = 0;
    for (const row of rows) {
      const node = options.render(row, true);
      host.append(node);
      if (!fits(node, height)) {
        // A table is whole or not there: past the card's height it goes, and "Open note" shows.
        if (options.atomic?.(row)) { node.remove(); hidden = true; break; }
        // A partial text block becomes plain text: clipped links must not remain focusable.
        if (clipText(node, () => fits(node, height))) nodes.push(node); else node.remove();
        hidden = true;
        break;
      }
      nodes.push(node);
      used++;
    }
    return { mode, nodes, height, tasks: 0, more: 0, checked: 0, wait: 0, hidden: hidden || used < rows.length || Boolean(options.truncated) };
  };
  const fit = () => {
    if (disposed || !host.isConnected || !host.clientWidth) return;
    const active = doc.activeElement;
    const focusAction = controls.contains(active) ? active.dataset.previewAction : undefined;
    const focusIndex = host.contains(active) ? [...host.querySelectorAll('button, input, a')].indexOf(active) : -1;
    const result = measure();
    host.replaceChildren(...result.nodes);
    // A preview at its height cap keeps its size when the text grows; its rows still notice.
    for (const node of watched) observer.unobserve(node);
    watched = result.nodes;
    for (const node of watched) observer.observe(node);
    host.style.maxHeight = `${result.height}px`;
    host.dataset.mode = result.mode;
    host.dataset.visibleTasks = String(result.tasks);
    host.dataset.hiddenTasks = String(result.more);
    host.dataset.checkedTasks = String(result.checked);
    controls.replaceChildren();
    const add = (label, kind) => {
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = label; button.dataset.previewAction = kind;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        options.open();
      });
      controls.append(button);
    };
    if (options.open) {
      if (result.more) add(options.openLabel(result.more), 'open');
      if (result.checked) add(options.checkedLabel(result.checked), 'checked');
      if (!result.more && !result.checked && result.hidden) add(options.openLabel(0), 'open');
    }
    controls.hidden = !controls.childElementCount;
    if (focusIndex >= 0) (host.querySelectorAll('button, input, a')[focusIndex] || controls.querySelector('button'))?.focus({ preventScroll: true });
    else if (focusAction) (controls.querySelector(`[data-preview-action="${focusAction}"]`) || controls.querySelector('button'))?.focus({ preventScroll: true });
    win.clearTimeout(settle);
    if (result.wait > 0) settle = win.setTimeout(fit, result.wait + 30);
    options.changed?.();
  };
  const schedule = () => {
    if (disposed) return;
    const style = win.getComputedStyle(host);
    const next = [host.clientWidth, style.fontSize, style.lineHeight, options.height()].join(':');
    if (next === signature) return;
    signature = next;
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(fit);
  };
  const observer = new win.ResizeObserver(schedule);
  observer.observe(host);
  if (options.resizeTarget) observer.observe(options.resizeTarget);
  win.addEventListener('resize', schedule);
  const fontsChanged = () => { signature = ''; schedule(); };
  doc.fonts?.addEventListener('loadingdone', fontsChanged);
  doc.fonts?.ready.then(fontsChanged);
  fit();
  return {
    fit,
    destroy() {
      disposed = true; observer.disconnect(); win.cancelAnimationFrame(frame); win.clearTimeout(settle);
      win.removeEventListener('resize', schedule);
      doc.fonts?.removeEventListener('loadingdone', fontsChanged);
    },
  };
}

let previewSequence = 0;
