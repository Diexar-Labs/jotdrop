// A small stand-in for the parts of Obsidian that the edit window's formatting bar uses (src/formatBar.ts), for the
// browser check scripts/check-format-bar-browser.py. Obsidian adds createEl, createDiv, setText, empty, show and hide
// to every element; this does the same, in a page without a vault, a network or a real Obsidian.
function make(tag, options = {}, parent) {
  const element = document.createElement(tag);
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attr || {})) element.setAttribute(name, String(value));
  parent?.append(element);
  return element;
}
const proto = HTMLElement.prototype;
proto.createEl = function (tag, options) { return make(tag, options, this); };
proto.createDiv = function (options) { return make("div", options, this); };
proto.createSpan = function (options) { return make("span", options, this); };
proto.setText = function (text) { this.textContent = text; };
proto.empty = function () { this.replaceChildren(); };
proto.show = function () { this.style.display = ""; };
proto.hide = function () { this.style.display = "none"; };
proto.isShown = function () { return this.style.display !== "none"; };
proto.addClass = function (...names) { this.classList.add(...names); };
proto.removeClass = function (...names) { this.classList.remove(...names); };
proto.hasClass = function (name) { return this.classList.contains(name); };
globalThis.createDiv = (options) => make("div", options);

export const Platform = { isMacOS: false, isMobile: false };
export const getLanguage = () => "en";
export const getIcon = () => null;
export const setIcon = () => {};

export class Scope {
  constructor(parent) { this.parent = parent; this.keys = []; }
  register(modifiers, key, handler) { this.keys.push({ modifiers, key, handler }); }
}

export class Menu {
  constructor() { this.items = []; }
  addItem(build) {
    const item = { title: "", handler: null, setTitle(title) { this.title = title; return this; }, setIcon() { return this; }, onClick(handler) { this.handler = handler; return this; } };
    build(item);
    this.items.push(item);
    return this;
  }
  showAtPosition() {
    const box = document.body.createDiv({ cls: "menu" });
    for (const item of this.items) {
      const button = box.createEl("button", { cls: "menu-item", text: item.title });
      button.addEventListener("click", () => { box.remove(); item.handler?.(); });
    }
    return this;
  }
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.scope = new Scope();
    // As Obsidian does: the window (modalEl) sits inside a full-screen container (containerEl).
    this.containerEl = make("div", { cls: "modal-container" });
    this.modalEl = make("div", { cls: "modal" });
    this.containerEl.append(this.modalEl);
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }
  open() { this.previous = document.activeElement; document.body.append(this.containerEl); this.onOpen(); }
  // As Obsidian does: the focus goes back to where it was before onClose runs.
  close() { if (!this.modalEl.isConnected) return; this.previous?.focus?.(); this.onClose(); this.containerEl.remove(); }
  onOpen() {}
  onClose() {}
}
