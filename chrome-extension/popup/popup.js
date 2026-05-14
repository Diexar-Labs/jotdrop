// ObsiDrop Web Clipper — popup logic
//
// Steps:
// 1. Read the active tab; retrieve title/url + selected text from the page DOM via
//    chrome.scripting.executeScript (one-time injection, no permanent content-script).
// 2. Populate the preview block and the selection field.
// 3. On Save → POST to 127.0.0.1:<port>/clip with Bearer token from storage.
//    On network error or 401: fall back to obsidian://obsidrop-clip?…

const $ = (id) => document.getElementById(id);
const els = {
  title: $("pageTitle"),
  url: $("pageUrl"),
  selection: $("selection"),
  tagsBox: $("tagsBox"),
  tags: $("tags"),
  color: $("color"),
  pinned: $("pinned"),
  saveBtn: $("saveBtn"),
  optionsBtn: $("optionsBtn"),
  status: $("status"),
};

let activeTab = null;
let currentTags = [];

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status status-${kind}`;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

/**
 * Executes a minimal in-page script that reads the title, og:meta tags and
 * selected text. Fails silently on chrome:// pages and similar restricted origins.
 */
async function readPageInfo(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const getMeta = (name) => {
          const el =
            document.querySelector(`meta[property="${name}"]`) ||
            document.querySelector(`meta[name="${name}"]`);
          return el ? el.getAttribute("content") || "" : "";
        };
        const selection = (window.getSelection && window.getSelection().toString()) || "";
        return {
          title: getMeta("og:title") || document.title || "",
          ogDescription: getMeta("og:description") || getMeta("description") || "",
          selection: selection.trim(),
        };
      },
    });
    return result || { title: "", ogDescription: "", selection: "" };
  } catch {
    return { title: "", ogDescription: "", selection: "" };
  }
}

async function init() {
  activeTab = await getActiveTab();
  if (!activeTab) {
    setStatus("No tab", "error");
    return;
  }
  els.title.textContent = activeTab.title || activeTab.url;
  els.url.textContent = activeTab.url;
  const info = await readPageInfo(activeTab.id);
  if (info.title) els.title.textContent = info.title;
  if (info.selection) els.selection.value = info.selection;
  setStatus("Ready", "idle");
}

async function getSettings() {
  const defaults = { port: 27124, token: "" };
  const stored = await chrome.storage.local.get(["port", "token"]);
  return { ...defaults, ...stored };
}

function normalizeTag(raw) {
  return raw.replace(/^#/, "").trim().replace(/\s+/g, "-");
}

function addTagsFromText(raw) {
  // Split on comma so that the old comma habit also triggers chip creation.
  for (const piece of raw.split(",")) {
    const t = normalizeTag(piece);
    if (t && !currentTags.includes(t)) currentTags.push(t);
  }
  renderTags();
}

function renderTags() {
  // Remove existing chips; re-render them before the input.
  els.tagsBox.querySelectorAll(".tag-chip").forEach((el) => el.remove());
  for (const tag of currentTags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = "#" + tag;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "tag-chip-remove";
    x.setAttribute("aria-label", "Remove tag " + tag);
    x.textContent = "×";
    x.addEventListener("click", () => {
      currentTags = currentTags.filter((t) => t !== tag);
      renderTags();
      els.tags.focus();
    });
    chip.appendChild(x);
    els.tagsBox.insertBefore(chip, els.tags);
  }
}

async function postClip(payload, settings) {
  const url = `http://127.0.0.1:${settings.port}/clip`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
  }
  return await res.json();
}

function buildObsidianUri(payload) {
  const qs = new URLSearchParams();
  qs.set("url", payload.url);
  if (payload.title) qs.set("title", payload.title);
  if (payload.selection) qs.set("selection", payload.selection);
  if (payload.tags && payload.tags.length) qs.set("tags", payload.tags.join(","));
  if (payload.color && payload.color !== "default") qs.set("color", payload.color);
  return `obsidian://obsidrop-clip?${qs.toString()}`;
}

async function save() {
  if (!activeTab) return;
  els.saveBtn.disabled = true;
  setStatus("Saving…", "busy");

  // Commit any pending text in the tags field as a chip, otherwise it is lost.
  const pending = els.tags.value.trim();
  if (pending) {
    addTagsFromText(pending);
    els.tags.value = "";
  }

  const payload = {
    url: activeTab.url,
    title: els.title.textContent || activeTab.title || activeTab.url,
    selection: els.selection.value.trim(),
    tags: [...currentTags],
    color: els.color.value,
    pinned: els.pinned.checked,
  };

  const settings = await getSettings();

  if (!settings.token) {
    setStatus("Set token first", "error");
    els.saveBtn.disabled = false;
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    await postClip(payload, settings);
    setStatus("Saved ✓", "ok");
    setTimeout(() => window.close(), 600);
  } catch (e) {
    console.warn("ObsiDrop: clip-server unreachable, falling back to obsidian:// URI", e);
    // Fallback opens Obsidian via the protocol handler. We cannot be certain the
    // plugin is active — the user will see the note in their vault once Obsidian
    // is open and the plugin is loaded.
    const uri = buildObsidianUri(payload);
    try {
      await chrome.tabs.update(activeTab.id, { url: uri });
      setStatus("Opened in Obsidian", "ok");
      setTimeout(() => window.close(), 800);
    } catch {
      setStatus(`Failed: ${e.message || e}`, "error");
      els.saveBtn.disabled = false;
    }
  }
}

els.saveBtn.addEventListener("click", () => { void save(); });
els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Tags input: Enter/comma commits a chip; Enter on an empty field saves immediately;
// Backspace on an empty field removes the last chip.
els.tags.addEventListener("keydown", (e) => {
  const v = els.tags.value;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    if (v.trim()) {
      addTagsFromText(v);
      els.tags.value = "";
    } else if (e.key === "Enter") {
      if (!els.saveBtn.disabled) void save();
    }
    return;
  }
  if (e.key === "Backspace" && v === "" && currentTags.length > 0) {
    e.preventDefault();
    currentTags.pop();
    renderTags();
  }
});

// Commit pending text on blur so that a half-typed tag is not lost.
els.tags.addEventListener("blur", () => {
  const v = els.tags.value.trim();
  if (v) {
    addTagsFromText(v);
    els.tags.value = "";
  }
});

// Click on empty space in the chip box → focus the input.
els.tagsBox.addEventListener("click", (e) => {
  if (e.target === els.tagsBox) els.tags.focus();
});

// Global Enter → Save, except in the selection textarea (Enter = newline there)
// and in the tags field (handled by its own listener above).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const t = e.target;
  if (t === els.selection || t === els.tags) return;
  // Buttons already activate themselves via Enter — do not fire twice.
  if (t instanceof HTMLButtonElement) return;
  e.preventDefault();
  if (!els.saveBtn.disabled) void save();
});

void init();
