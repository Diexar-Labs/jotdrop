const $ = (id) => document.getElementById(id);
const els = {
  port: $("port"),
  token: $("token"),
  paste: $("paste"),
  saveTest: $("saveTest"),
  status: $("status"),
};

async function load() {
  const { port = 27124, token = "" } = await chrome.storage.local.get(["port", "token"]);
  els.port.value = port;
  els.token.value = token;
}

function setStatus(text, ok) {
  els.status.textContent = text;
  els.status.style.color = ok === undefined
    ? "var(--muted)"
    : ok ? "var(--fg)" : "var(--danger-border)";
  els.status.style.fontWeight = ok === false ? "600" : "normal";
}

async function saveAndTest() {
  // Save first so entered settings are never lost, even if the test fails.
  const port = parseInt(els.port.value, 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    setStatus("Invalid port (1024–65535) — settings not saved", false);
    return;
  }
  const token = els.token.value.trim();
  await chrome.storage.local.set({ port, token });

  if (!token) {
    setStatus("No token saved — the clipper keeps working in direct mode.", false);
    return;
  }

  setStatus("Testing…");
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.app === "jotdrop") {
      setStatus("Connection OK — JotDrop is running.", true);
    } else {
      setStatus("Reached the server, but it is not JotDrop. Check the port.", false);
    }
  } catch {
    setStatus(
      "Saved, but cannot reach the plugin. Make sure Obsidian desktop, the JotDrop plugin, and its clip server are running.",
      false,
    );
  }
}

els.saveTest.addEventListener("click", () => { void saveAndTest(); });
els.paste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) els.token.value = text.trim();
  } catch {
    setStatus("Clipboard read denied — paste manually.", false);
  }
});

void load();
// --- Where clips go, and JotDrop Cloud ---------------------------------------------------------------------

const cloud = globalThis.JotDropCloud;
const DESTINATION_TEXT = {
  obsidian: "Saved: clips go to Obsidian.",
  cloud: "Saved: clips go to JotDrop Cloud.",
  both: "Saved: clips go to JotDrop Cloud and Obsidian.",
};
const radios = [...document.querySelectorAll('input[name="destination"]')];

function cloudMessage(text) {
  $("cloudMessage").textContent = text;
}

async function storedDestination() {
  const { destination, cloudEnabled } = await chrome.storage.local.get(["destination", "cloudEnabled"]);
  return DESTINATION_TEXT[destination] ? destination : cloudEnabled ? "cloud" : "obsidian";
}

function showSections(destination) {
  $("obsidianSection").hidden = destination === "cloud";
  $("cloudSection").hidden = destination === "obsidian";
}

const hostPermission = (server) => `${server}/*`;
const needsPermission = (server) => server.startsWith("https:");

async function renderCloud() {
  const state = await cloud.status();
  $("cloudPair").hidden = state.connected;
  $("cloudConnected").hidden = !state.connected;
  if (!state.connected) {
    $("cloudState").textContent = "Not connected.";
    return;
  }
  const host = new URL(state.server).host;
  const allowed = !needsPermission(state.server) || await chrome.permissions.contains({ origins: [hostPermission(state.server)] });
  $("cloudAllow").hidden = allowed;
  $("cloudLockNow").hidden = !state.unlocked;
  const parts = [`Connected to ${host}.`];
  if (!allowed) parts.push(`Access to ${host} is off: allow it to save clips.`);
  parts.push(state.unlocked ? "Unlocked until the browser closes." : "Locked: the popup asks for the unlock passphrase.");
  if (state.drafts) parts.push(`${state.drafts} encrypted ${state.drafts === 1 ? "draft waits" : "drafts wait"} to be sent.`);
  $("cloudState").textContent = parts.join(" ");
}

async function chooseDestination(destination) {
  await chrome.storage.local.set({ destination });
  await chrome.storage.local.remove("cloudEnabled");
  showSections(destination);
  const state = await cloud.status();
  $("destinationStatus").textContent = destination !== "obsidian" && !state.connected
    ? `${DESTINATION_TEXT[destination]} Connect JotDrop Cloud below to start.`
    : DESTINATION_TEXT[destination];
}

async function connectCloud() {
  const button = $("cloudConnect");
  let pairing;
  try {
    pairing = cloud.readPairingCode($("cloudPairCode").value);
  } catch (error) {
    cloudMessage(error.message);
    return;
  }
  const password = $("cloudPairPassword").value;
  if (password.length < 12) { cloudMessage("Choose an unlock passphrase of at least 12 characters."); return; }
  if (password !== $("cloudPairRepeat").value) { cloudMessage("The two passphrases are not the same."); return; }
  button.disabled = true;
  try {
    // Asked while the click still counts as the person's own action, before anything else is awaited.
    if (needsPermission(pairing.origin) && !await chrome.permissions.request({ origins: [hostPermission(pairing.origin)] })) {
      throw new Error(`Access to ${new URL(pairing.origin).host} was not allowed. Nothing changed.`);
    }
    cloudMessage("Connecting...");
    await cloud.connect(pairing.code, password);
    $("cloudPairCode").value = "";
    $("cloudPairPassword").value = "";
    $("cloudPairRepeat").value = "";
    const destination = await storedDestination();
    radios.forEach((radio) => { radio.checked = radio.value === destination; });
    showSections(destination);
    $("destinationStatus").textContent = DESTINATION_TEXT[destination];
    cloudMessage("Connected ✓ Clips are encrypted in this browser before they go to your cloud.");
  } catch (error) {
    const text = error.code === "device-limit"
      ? "Your Free plan has no free device place. Sign out a device in the web app (Devices & recovery), or try JotDrop Plus, then make a new code."
      : error.status === 401 || error.status === 409 || error.status === 410
        ? `${error.message}. Make a new pairing code in the web app; a code works once, for 10 minutes.`
        : error.message || "Could not connect. Check the code and your internet connection.";
    cloudMessage(text);
  } finally {
    button.disabled = false;
    await renderCloud();
  }
}

async function allowCloud() {
  const { server } = await cloud.status();
  if (server && await chrome.permissions.request({ origins: [hostPermission(server)] })) cloudMessage(`Access to ${new URL(server).host} allowed ✓`);
  else cloudMessage("Access was not allowed. Cloud saves stay off until it is.");
  await renderCloud();
}

async function disconnectCloud() {
  const password = $("cloudDisconnectPassword").value;
  try {
    const result = await cloud.disconnect(password || undefined);
    $("cloudDisconnectPassword").value = "";
    const parts = ["Disconnected: the cloud keys are removed from this browser."];
    if (result.droppedDrafts) parts.push(`${result.droppedDrafts} unsent ${result.droppedDrafts === 1 ? "draft was" : "drafts were"} removed.`);
    parts.push(result.signedOut
      ? "The clipper signed itself out of your cloud."
      : `${result.signOutError ? `Signing out failed (${result.signOutError}). ` : ""}Sign out "Web clipper" in the web app under Devices & recovery to free its place.`);
    const destination = await storedDestination();
    radios.forEach((radio) => { radio.checked = radio.value === destination; });
    showSections(destination);
    // Shown next to the choice, which stays visible when the cloud part closes.
    parts.push(DESTINATION_TEXT[destination]);
    cloudMessage("");
    $("destinationStatus").textContent = parts.join(" ");
  } catch (error) {
    cloudMessage(error.message || "Could not disconnect.");
  }
  await renderCloud();
}

async function loadDestination() {
  const destination = await storedDestination();
  radios.forEach((radio) => { radio.checked = radio.value === destination; });
  showSections(destination);
  if (!cloud) {
    radios.filter((radio) => radio.value !== "obsidian").forEach((radio) => { radio.disabled = true; });
    $("destinationStatus").textContent = "Cloud support is missing from this build.";
    return;
  }
  await renderCloud();
}

radios.forEach((radio) => radio.addEventListener("change", () => { if (radio.checked) void chooseDestination(radio.value); }));
$("cloudConnect").addEventListener("click", () => { void connectCloud(); });
$("cloudAllow").addEventListener("click", () => { void allowCloud(); });
$("cloudLockNow").addEventListener("click", async () => { await cloud.lock(); cloudMessage("Locked."); await renderCloud(); });
$("cloudDisconnect").addEventListener("click", () => { void disconnectCloud(); });

void loadDestination();
