
const $ = (id) => document.getElementById(id);
const LOG_KEY = "popupLog";

const DEFAULT_WEBHOOK = "";

function renderLog(entries) {
  const logEl = $("log");
  logEl.innerHTML = "";

  for (const entry of entries) {
    const div = document.createElement("div");
    if (entry.kind) div.className = entry.kind;
    div.textContent = entry.msg;
    logEl.appendChild(div);
  }

  logEl.scrollTop = logEl.scrollHeight;
}

async function loadPersistedLog() {
  const stored = await chrome.storage.local.get([LOG_KEY]);
  const entries = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  renderLog(entries);
}

function checkForUpdate() {
  const statusEl = $("updateStatus");
  statusEl.textContent = "Checking for updates...";

  chrome.runtime.sendMessage({ type: "CHECK_UPDATE" }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      statusEl.textContent = "Could not check for updates.";
      return;
    }

    statusEl.innerHTML = response.isUpdateAvailable
      ? "An update is available <a href='https://github.com/5ch3m45/nyaham/releases' target='_blank'>here</a>."
      : "You are up to date.";
  });
}

async function appendLog(msg, kind) {
  const logEl = $("log");
  const stored = await chrome.storage.local.get([LOG_KEY]);
  const existing = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];

  const entry = { msg, kind };
  const next = [...existing, entry].slice(-200);
  await chrome.storage.local.set({ [LOG_KEY]: next });

  const div = document.createElement("div");
  if (kind) div.className = kind;
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadSettings() {
  const s = await chrome.storage.local.get(["apiKey", "webhookUrl", "model", "saveToFile"]);
  $("apiKey").value = s.apiKey || "";
  $("webhookUrl").value = s.webhookUrl || DEFAULT_WEBHOOK;
  $("model").value = s.model || "deepseek/deepseek-v4-flash";
  $("saveToFile").checked = s.saveToFile === undefined ? true : Boolean(s.saveToFile);
  updateWebhookVisibility();
}

function updateWebhookVisibility() {
  $("webhookField").classList.toggle("hidden", $("saveToFile").checked);
}

async function saveSettings() {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    webhookUrl: $("webhookUrl").value.trim(),
    model: $("model").value.trim() || "deepseek/deepseek-v4-flash",
    saveToFile: $("saveToFile").checked,
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const today = new Date().toISOString().slice(0, 10);
  $("dateFrom").value = today;
  $("dateTo").value = today;
  loadSettings();
  loadPersistedLog();
  checkForUpdate();
});

$("close").addEventListener("click", () => {
  window.close();
});

$("saveToFile").addEventListener("change", updateWebhookVisibility);

 $("start").addEventListener("click", async () => {
  const dateFrom = $("dateFrom").value;
  const dateTo = $("dateTo").value;
  if (!dateFrom || !dateTo) { alert("Pick both dates!"); return; }
  if (!$("apiKey").value.trim()) { alert("Set your OpenRouter API key in Settings first."); return; }

  await saveSettings();
  $("start").disabled = true;
  appendLog("Starting background job...");

  chrome.runtime.sendMessage({ type: "START", dateFrom, dateTo });
});

 $("clearCache").addEventListener("click", async () => {
  await chrome.storage.local.remove("cache");
  alert("Cache cleared — everything will be re-analyzed next run.");
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "LOG") appendLog(msg.msg, msg.kind);
  if (msg.type === "DONE") $("start").disabled = false;
});