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