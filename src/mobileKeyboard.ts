import type { Modal } from "obsidian";

/** Fit mobile note dialogs to the space above the keyboard, not the layout viewport. */
export function keepModalAboveKeyboard(modal: Modal): () => void {
  const el = modal.modalEl;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!win || !doc.body.classList.contains("is-mobile")) return () => {};
  const viewport = win.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    const top = viewport?.offsetTop ?? 0;
    // Obsidian Android can overlay the IME without resizing visualViewport.
    const keyboard = parseFloat(win.getComputedStyle(doc.body).getPropertyValue("--keyboard-height")) || 0;
    const height = Math.max(0, Math.min(viewport?.height ?? win.innerHeight, win.innerHeight - keyboard - top));
    el.style.setProperty("--jotdrop-viewport-height", `${height}px`);
    el.style.setProperty("--jotdrop-viewport-top", `${top}px`);
    const active = doc.activeElement;
    if (active && el.contains(active) && active.matches("input, textarea")) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(update);
  };
  el.classList.add("jotdrop-keyboard-modal");
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  el.addEventListener("focusin", schedule);
  el.addEventListener("input", schedule);
  const insets = new win.MutationObserver(schedule);
  insets.observe(doc.body, { attributes: true, attributeFilter: ["style"] });
  insets.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
  schedule();
  return () => {
    win.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    el.removeEventListener("focusin", schedule);
    el.removeEventListener("input", schedule);
    insets.disconnect();
    el.classList.remove("jotdrop-keyboard-modal");
    el.style.removeProperty("--jotdrop-viewport-height");
    el.style.removeProperty("--jotdrop-viewport-top");
  };
}
