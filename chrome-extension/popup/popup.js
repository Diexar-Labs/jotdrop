// JotDrop Web Clipper — popup logic
//
// Steps:
// 1. Read the active tab; retrieve title/url + selected text from the page DOM via
//    chrome.scripting.executeScript (one-time injection, no permanent content-script).
// 2. Populate the preview block and the selection field.
// 3. On Save → if no token is configured (zero-config default), open an
//    obsidian://jotdrop-clip URI; Obsidian launches and creates the card.
//    With a saved token → POST to 127.0.0.1:<port>/clip; on network error or
//    401 fall back to the same URI helper (shared, no duplicated logic).
// 4. With JotDrop Cloud chosen in Settings ("cloud" or "both"), the clip is
//    encrypted here and uploaded by ../cloud-client.js (JotDropCloud); "both"
//    then also runs step 3.

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
let cloudCaptureId = crypto.randomUUID();
let cloudTransfer;
// True when the chosen destination includes JotDrop Cloud.
let cloudWanted = false;

const DESTINATION_NAMES = {
  obsidian: "Obsidian",
  cloud: "JotDrop Cloud (encrypted)",
  both: "JotDrop Cloud and Obsidian",
};

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
  const settings = await getSettings();
  cloudWanted = settings.destination !== "obsidian";
  $("destinationName").textContent = DESTINATION_NAMES[settings.destination];
  const cloud = await refreshCloud().catch(() => null);
  if (cloudWanted && !cloud?.connected) {
    setStatus("Cloud: connect in Settings", "idle");
  } else if (cloudWanted && !cloud.unlocked) {
    setStatus("Cloud: unlock to save", "idle");
  } else if (cloudWanted) {
    setStatus("Ready", "idle");
  } else if (!settings.token) {
    // Zero-config default: saving opens Obsidian via the obsidian:// protocol.
    setStatus("Direct mode: Save opens Obsidian", "idle");
  } else {
    setStatus("Ready", "idle");
  }
}

async function getSettings() {
  const defaults = { port: 27124, token: "" };
  const stored = await chrome.storage.local.get(["port", "token", "destination", "cloudEnabled"]);
  // "cloudEnabled" is the 0.1 development preview's switch; "destination" replaces it.
  const destination = DESTINATION_NAMES[stored.destination] ? stored.destination : stored.cloudEnabled ? "cloud" : "obsidian";
  return { ...defaults, ...stored, destination };
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

function openObsidianUri(payload) {
  const serialized = JotDropProtocol.serializeDirectClip(payload);
  if (!serialized.ok) {
    setStatus(
      "Selection too long for direct mode: shorten the selection or enable the background connection in Settings",
      "error",
    );
    return false;
  }
  try {
    void chrome.tabs.update(activeTab.id, { url: serialized.uri });
    return true;
  } catch {
    setStatus("Failed to open Obsidian", "error");
    return false;
  }
}

// Design A's moment after a save, as in the web app: the page card drops onto the board and gets a stamp.
function stampPreview(text) {
  const preview = document.querySelector(".preview");
  const stamp = document.createElement("span");
  stamp.className = "preview-stamp";
  stamp.setAttribute("aria-hidden", "true");
  stamp.textContent = text;
  preview.append(stamp);
  preview.classList.add("is-saved");
}

async function save() {
  if (!activeTab || els.saveBtn.disabled) return;
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

  if (settings.destination === "cloud") {
    await saveCloud(payload);
    return;
  }
  if (settings.destination === "both") {
    await saveBoth(payload, settings);
    return;
  }

  const result = await sendToObsidian(payload, settings);
  if (result === "saved") {
    setStatus("Saved ✓", "ok");
    stampPreview("Saved");
    setTimeout(() => window.close(), 900);
  } else if (result === "opened") {
    setStatus("Opened in Obsidian", "ok");
    setTimeout(() => window.close(), 800);
  } else {
    els.saveBtn.disabled = false;
  }
}

/**
 * The Obsidian route, unchanged since 0.1: without a token the obsidian:// link (Obsidian creates the card);
 * with a token the plugin's clip server on 127.0.0.1, falling back to the link when it cannot be reached.
 * Returns "saved" (clip server), "opened" (link) or false (the error is already shown).
 */
async function sendToObsidian(payload, settings) {
  // Zero-config: no token → open the clip URI directly; Obsidian creates the card.
  if (JotDropProtocol.pickRoute(settings) === "direct") {
    return openObsidianUri(payload) ? "opened" : false;
  }

  try {
    await postClip(payload, settings);
    return "saved";
  } catch (e) {
    console.warn("JotDrop: clip-server unreachable, falling back to obsidian:// URI", e);
    // Fallback opens Obsidian via the protocol handler. We cannot be certain the
    // plugin is active — the user will see the note in their vault once Obsidian
    // is open and the plugin is loaded.
    return openObsidianUri(payload) ? "opened" : false;
  }
}

// Both: the cloud first (it can ask for the passphrase before anything is saved), then Obsidian.
async function saveBoth(payload, settings) {
  const cloud = await saveCloud(payload, { finish: false });
  if (cloud === "locked") return;
  const cloudError = cloud === "ok" ? "" : els.status.textContent;
  els.saveBtn.disabled = true;
  const obsidian = await sendToObsidian(payload, settings);
  els.saveBtn.disabled = false;
  if (cloud === "ok" && obsidian) {
    setStatus(obsidian === "saved" ? "Saved to JotDrop Cloud and Obsidian ✓" : "Saved to JotDrop Cloud ✓ Opened in Obsidian", "ok");
    stampPreview("Saved");
    setTimeout(() => window.close(), 900);
  } else if (obsidian) {
    setStatus(`Cloud: ${cloudError} ${obsidian === "saved" ? "Obsidian saved it." : "Obsidian was opened."}`, "error");
  } else if (cloud === "ok") {
    setStatus(`Saved to JotDrop Cloud ✓ Obsidian: ${els.status.textContent}`, "error");
  }
}

/** Shows the unlock field, "stay unlocked" and the draft buttons as the cloud state asks. */
async function refreshCloud() {
  const box = $("cloudBox");
  if (!cloudWanted) {
    box.hidden = true;
    return null;
  }
  box.hidden = false;
  if (!globalThis.JotDropCloud) return null;
  const state = await globalThis.JotDropCloud.status();
  $("cloudUnlockField").hidden = !state.connected || state.unlocked;
  $("cloudKeepField").hidden = !state.connected || state.unlocked || !state.canStayUnlocked;
  $("cloudUnlocked").hidden = !state.unlocked;
  $("cloudResume").hidden = !state.connected || state.drafts === 0;
  return state;
}

/** Returns "ok", "locked" (nothing was sent: connect or unlock first) or "failed" (any encrypted draft is kept). */
async function saveCloud(payload, { finish = true } = {}) {
  if (cloudTransfer) return "failed";
  const controller = new AbortController();
  cloudTransfer = controller;
  els.saveBtn.disabled = true;
  const resume = $("cloudResume"), pause = $("cloudPause"), progress = $("cloudProgress");
  const password = $("cloudUnlock");
  const locked = (message) => Object.assign(new Error(message), { code: "locked" });
  let outcome = "failed";
  try {
    if (!globalThis.JotDropCloud) throw locked("Cloud support is missing from this build.");
    const state = await globalThis.JotDropCloud.status();
    if (!state.connected) throw locked("Connect JotDrop Cloud in Settings first.");
    if (!state.unlocked && !password.value) throw locked("Enter your cloud unlock passphrase.");
    if (state.server.startsWith("https:") && globalThis.chrome?.permissions && !await chrome.permissions.contains({ origins: [`${state.server}/*`] })) {
      throw locked(`Open Settings and allow access to ${new URL(state.server).host}.`);
    }
    if (resume) resume.disabled = true;
    if (pause) pause.hidden = false;
    const options = { signal: controller.signal, keepUnlocked: !$("cloudKeepField").hidden && $("cloudKeep").checked, onCaptureCommitted: (captureId) => {
      if (captureId === cloudCaptureId) cloudCaptureId = crypto.randomUUID();
    }, onProgress: ({ phase, transferredBytes, totalBytes }) => {
      if (controller.signal.aborted) return;
      progress.hidden = false; progress.max = totalBytes; progress.value = transferredBytes;
      setStatus(phase === "committed" ? "Cloud version confirmed" : phase === "committing" ? "Finalizing cloud version..." : `${Math.floor(transferredBytes / 1024)} / ${Math.ceil(totalBytes / 1024)} KiB encrypted bytes confirmed`, "busy");
    } };
    const secret = state.unlocked ? undefined : password.value;
    if (payload) await globalThis.JotDropCloud.save(payload, secret, cloudCaptureId, options);
    else {
      const count = await globalThis.JotDropCloud.resume(secret, options);
      password.value = "";
      setStatus(count ? "Saved drafts confirmed in cloud. Current page was not clipped." : "No saved cloud drafts. Current page was not clipped.", "ok");
      outcome = "ok";
      return outcome;
    }
    password.value = "";
    outcome = "ok";
    if (finish) {
      setStatus("Encrypted clip saved to cloud", "ok");
      stampPreview("Sealed");
      setTimeout(() => window.close(), 900);
    }
  } catch (error) {
    if (error.code === "locked") {
      outcome = "locked";
      setStatus(error.message, "error");
    } else {
      setStatus(controller.signal.aborted ? "Upload paused. Encrypted drafts are kept; select Resume saved drafts to continue." : `${error.message || "Cloud save failed."} Any queued encrypted draft is kept unchanged.`, "error");
    }
  } finally {
    cloudTransfer = undefined;
    els.saveBtn.disabled = false;
    if (resume) resume.disabled = false;
    if (pause) pause.hidden = true;
    if (progress) progress.hidden = true;
    await refreshCloud().catch(() => null);
    if (controller.signal.aborted) resume?.focus();
    else if (outcome === "locked" && !$("cloudUnlockField").hidden) password.focus();
  }
  return outcome;
}

$("cloudPause").addEventListener("click", () => cloudTransfer?.abort());
$("cloudResume").addEventListener("click", () => { void saveCloud(); });
$("cloudLock").addEventListener("click", async () => {
  await globalThis.JotDropCloud?.lock();
  await refreshCloud();
  setStatus("Cloud: unlock to save", "idle");
});
window.addEventListener("pagehide", () => cloudTransfer?.abort());

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
