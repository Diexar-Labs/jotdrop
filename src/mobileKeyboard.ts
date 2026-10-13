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
    el.style.setProperty("--jotdrop-viewport-height", `${viewport?.height ?? win.innerHeight}px`);
    el.style.setProperty("--jotdrop-viewport-top", `${viewport?.offsetTop ?? 0}px`);
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
  schedule();
  return () => {
    win.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    el.removeEventListener("focusin", schedule);
    el.removeEventListener("input", schedule);
    el.classList.remove("jotdrop-keyboard-modal");
    el.style.removeProperty("--jotdrop-viewport-height");
    el.style.removeProperty("--jotdrop-viewport-top");
  };
}
