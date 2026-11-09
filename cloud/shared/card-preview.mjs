// Presentation only: callers retain their own parser, source identities and write path.
export function cardPreview(host, rows, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const controls = doc.createElement('div');
  if (!host.id) host.id = `compact-preview-${++previewSequence}`;
  controls.className = 'compact-preview-controls';
  host.after(controls);
  let signature = '', frame = 0, disposed = false;
  const total = rows.filter(options.isTask).length;
  const measure = (expanded) => {
    host.replaceChildren();
    const height = Math.max(0, Math.min(expanded ? 320 : 200, options.height() * (expanded ? .6 : .4)));
    host.style.maxHeight = `${height}px`;
    const max = expanded ? 10 : 5;
    let lastTask = -1;
    rows.forEach((row, i) => { if (options.isTask(row)) lastTask = i; });
    let tasks = 0, hidden = false, used = 0, textUsed = 0, textFull = false;
    const nodes = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], task = options.isTask(row);
      if (task && tasks >= max) { hidden = true; break; }
      // Text with a visible task still to come may fill at most half the preview,
      // so a long introduction cannot push every checkbox out of the card.
      const capped = !task && i < lastTask && tasks < max;
      if (capped && textFull) { hidden = true; continue; }
      const node = options.render(row);
      host.append(node);
      const top = node.getBoundingClientRect().top - host.getBoundingClientRect().top;
      const limit = capped ? Math.min(height, top + height / 2 - textUsed) : height;
      if (top + node.getBoundingClientRect().height > limit + .5) {
        if (task) { node.remove(); hidden = true; break; }
        // A partial text block becomes plain text: clipped links must not remain focusable.
        const chars = Array.from(node.textContent || '');
        let low = 0, high = chars.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          node.textContent = chars.slice(0, mid).join('') + '…';
          if (top + node.getBoundingClientRect().height <= limit + .5) low = mid;
          else high = mid - 1;
        }
        node.textContent = chars.slice(0, low).join('') + '…';
        if (top + node.getBoundingClientRect().height > limit + .5) node.remove();
        else nodes.push(node);
        hidden = true;
        if (capped) { textFull = true; continue; }
        break;
      }
      nodes.push(node);
      used++;
      if (capped) textUsed += node.getBoundingClientRect().height;
      if (task) {
        tasks++;
        const text = node.querySelector('[data-preview-task-text]');
        if (text && text.scrollHeight > text.clientHeight + 1) {
          hidden = true;
          // A line-clamped link can span invisible lines; keep only its noninteractive label.
          for (const link of text.querySelectorAll('a, button, [tabindex]')) link.replaceWith(doc.createTextNode(link.textContent || ''));
        }
      }
    }
    return { nodes, tasks, hidden: hidden || used < rows.length || Boolean(options.truncated), height };
  };
  const fit = () => {
    if (disposed || !host.isConnected || !host.clientWidth) return;
    const active = doc.activeElement;
    const focusAction = controls.contains(active) ? active.dataset.previewAction : undefined;
    const focusIndex = host.contains(active) ? [...host.querySelectorAll('button, input, a')].indexOf(active) : -1;
    const compact = measure(false);
    const expanded = measure(true);
    const result = options.expanded() ? expanded : compact;
    host.replaceChildren(...result.nodes);
    host.style.maxHeight = `${result.height}px`;
    host.dataset.visibleTasks = String(result.tasks);
    host.dataset.hiddenTasks = String(total - result.tasks);
    controls.replaceChildren();
    const add = (label, action, kind) => {
      const button = doc.createElement('button');
      button.type = 'button'; button.textContent = label; button.dataset.previewAction = kind;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      controls.append(button);
      return button;
    };
    if (options.expanded() || expanded.tasks > compact.tasks) {
      const toggle = add(options.expanded() ? options.less : options.more, () => {
        const card = host.closest('article') || host.parentElement;
        const before = card.getBoundingClientRect().top;
        options.toggle(); fit();
        const scroller = options.scroller?.() || doc.scrollingElement;
        if (scroller) scroller.scrollTop += card.getBoundingClientRect().top - before;
        controls.querySelector('[data-preview-action="toggle"]')?.focus({ preventScroll: true });
      }, 'toggle');
      toggle.setAttribute('aria-expanded', String(options.expanded()));
      toggle.setAttribute('aria-controls', host.id);
    }
    if (result.hidden && options.open) add(options.openLabel(total - result.tasks), options.open, 'open');
    controls.hidden = !controls.childElementCount;
    if (focusIndex >= 0) (host.querySelectorAll('button, input, a')[focusIndex] || controls.querySelector('button'))?.focus({ preventScroll: true });
    else if (focusAction) (controls.querySelector(`[data-preview-action="${focusAction}"]`) || controls.querySelector('button'))?.focus({ preventScroll: true });
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
      disposed = true; observer.disconnect(); win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', schedule);
      doc.fonts?.removeEventListener('loadingdone', fontsChanged);
    },
  };
}

let previewSequence = 0;
