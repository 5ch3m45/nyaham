// ================= Config =================
const IDX_URL =
  "https://www.idx.co.id/id/perusahaan-tercatat/keterbukaan-informasi";
// const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_URL = "https://api.vikey.ai/v1/chat/completions";
const UPDATE_CHECK_URL = "https://kodebita.com/idx-keterbukaan-update-check";
const LOG_KEY = "popupLog";
let activeHeartbeat = null;

// ================= Utils =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function persistLog(msg, kind = "info") {
  try {
    const stored = await chrome.storage.local.get([LOG_KEY]);
    const entries = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    const next = [...entries, { msg, kind }].slice(-200);
    await chrome.storage.local.set({ [LOG_KEY]: next });
  } catch (e) {
    // ignore storage failures so background work still continues
  }
}

function log(msg, kind = "info") {
  try { chrome.runtime.sendMessage({ type: "LOG", msg, kind }); } catch {}
  persistLog(msg, kind).catch(() => {});
}

function startScrapeHeartbeat() {
  const startedAt = Date.now();
  let stage = "starting";
  const heartbeat = {
    setStage(nextStage) {
      stage = nextStage;
    },
    stop() {
      clearInterval(heartbeat.timer);
      if (activeHeartbeat === heartbeat) activeHeartbeat = null;
    },
    timer: null,
  };

  heartbeat.timer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    log(`⏱ ${elapsedSeconds}s - ${stage}`);
  }, 1000);
  activeHeartbeat = heartbeat;
  return heartbeat;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ================= Injected page functions (run on idx.co.id) =================

async function selectFilterOption() {
  document.querySelector("#vs1__combobox .vs__open-indicator")?.click();
  await new Promise((r) => setTimeout(r, 500));
  document.querySelector("#vs1__listbox li:nth-child(2)")?.click();
  return true;
}

function setDateFilter(dateRange) {
  const input = document.querySelector("input[name='date']");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value"
  ).set;
  setter.call(input, dateRange);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function scrapeCardsInPage() {
  const results = [];
  for (const card of document.querySelectorAll("div.attach-card")) {
    const timeEl = card.querySelector("time");
    const publishDate = timeEl ? timeEl.innerText.trim() : "";

    let title = "", pdfUrl = "";
    const titleLink = card.querySelector("h6.title a");
    if (titleLink) {
      title = titleLink.innerText.trim();
      pdfUrl = titleLink.href || ""; // .href = absolute URL
    }

    const links = [];
    for (const a of card.querySelectorAll("ul.list-nostyle a")) {
      const small = a.querySelector("small");
      const text = small ? small.innerText.trim() : a.innerText.trim();
      if (a.href) links.push({ text, url: a.href });
    }

    const m = title.match(/\[([^\]]+)\]/);
    results.push({
      publishDate, title, pdfUrl, links,
      ticker: m ? m[1].trim() : "",
    });
  }
  return results;
}

function clickNextInPage() {
  const btn = document.querySelector("button.btn-arrow.--next");
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

// ================= Prompt rules (ported 1:1 from Python) =================
function buildPrompt(title) {
  const t = title.toLowerCase();

  if (t.includes("transaksi material") || t.includes("transaksi afiliasi")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, barang (apa yang di transaksikan), pelaku (transaksi dilakukan antara siapa), nilai (transaksi dalam rupiah), prospek (bagaimana prospek transaksi tersebut), saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  if ((t.includes("rupslb") || t.includes("rapat umum pemegang saham luar biasa") || t.includes("rapat umum para pemegang saham luar biasa")) &&
      !t.includes("pemanggilan") && !t.includes("pemberitahuan rencana") &&
      !t.includes("bukti iklan") && !t.includes("perubahan jadwal") &&
      !t.includes("penundaan") && !t.includes("pembatalan")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, keputusan (apa saja keputusan yang diambil dalam rupslb tersebut), saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  if (t.includes("kepemilikan")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, pemegang saham (siapa saja pemegang saham yang memiliki saham), kepemilikan sebelum (berapa persen kepemilikan masing-masing pemegang saham), kepemilikan sesudah (berapa persen kepemilikan masing-masing pemegang saham), tanggal transaksi, saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  if (t.includes("laporan hasil public expose") || t.includes("materi public expose")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, growth story (cari growth story emiten tersebut berdasarkan materi pubex tersebut), saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  if (t.includes("hmetd") && !t.includes("jumlah saham") && !t.includes("perdagangan") && !t.includes("jadwal") && !t.includes("bukti iklan")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, jumlah saham (berapa jumlah saham yang diterbitkan), harga (berapa harga saham yang diterbitkan), total dana (berapa total dana yang diperoleh dari penerbitan saham tersebut), right issue atau private placement, tujuan penambahan modal, prospek penambahan modal, saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  if (t.includes("perubahan pengurus") || t.includes("perubahan direksi") || t.includes("perubahan komisaris") || t.includes("perubahan anggota")) {
    return "analisa dokumen tersebut dan buatkan json yang berisi key: kode saham, pengurus (siapa saja pengurus yang diangkat atau diberhentikan), jabatan (jabatan masing-masing pengurus), background (lakukan background check pengurus/direksi/komisaris barunya, siapa dia, apakah punya afiliasi politik atau konglomerasi, dan history pekerjaannya apa saja. jika tidak bisa ditemukan dari dokumen, tolong carikan di internet), saran (saran untuk investor terkait transaksi tersebut: 🚀strong buy, 💰buy, no action, sell, ⛔strong sell).";
  }
  return "";
}

// ================= Discord formatter (ported) =================
function formatValue(value, indent = "") {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value)
      .map(([k, v]) => `${indent}- **${k}**: ${formatValue(v, indent + "  ")}`)
      .join("\n");
  }
  if (Array.isArray(value)) {
    return value.map((item) => `${indent}- ${formatValue(item, indent + "  ")}`).join("\n");
  }
  return String(value);
}

function discordMessageFormatter(content) {
  try {
    // strip possible ```json fences
    const cleaned = content.replace(/```(json)?/g, "").trim();
    const data = JSON.parse(cleaned);
    let formatted = "";
    for (const [k, v] of Object.entries(data)) {
      let val = v;
      if (typeof v === "number") {
        if (["nilai", "total_dana", "total dana"].includes(k)) {
          val = `Rp${v.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
        } else if (k === "jumlah saham") {
          val = `${v.toLocaleString("en-US")} lot`;
        }
      }
      formatted += `**${k}**: ${formatValue(val)}\n`;
    }
    return formatted;
  } catch {
    return content; // not valid JSON, send raw
  }
}

// ================= PDF download + text extraction =================
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Parse PDF disclosures with pdf.js to extract text",
  });
}

async function extractPdfTextFromBuffer(arrayBuffer) {
  log(`💾 Extracting text from PDF buffer (${arrayBuffer.byteLength} bytes) via offscreen...`);
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    type: "EXTRACT_PDF",
    base64: toBase64(arrayBuffer),
  });
  if (!response?.ok) throw new Error(response?.error || "offscreen: no response");
  return response.text;
}

async function extractPdfTextFromFile(filePath) {
  let fileUrl = filePath;
  if (!/^(https?:|file:)/i.test(filePath)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
      fileUrl = `file:///${normalized.replace(/^([A-Za-z]):\//, "$1:/")}`;
    } else {
      fileUrl = `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
    }
  }

  log(`💾 Extracting text from saved PDF file: ${fileUrl} via offscreen...`);

  try {
    const resp = await fetch(fileUrl);
    log(`💾 Fetched saved PDF file: ${fileUrl} -> ${resp.status} (${resp.headers.get("content-type") || "?"})`);
    if (!resp.ok) {
      log(`⛔ Cannot read saved PDF: HTTP ${resp.status}`, "error");
      throw new Error(`Cannot read saved PDF: HTTP ${resp.status}`);
    }
    return await extractPdfTextFromBuffer(await resp.arrayBuffer());
  } catch (e) {
    log(`⛔ Browser blocked local file read for ${fileUrl}: ${e.message}`, "error");
    throw new Error(`Browser blocked local file read: ${filePath}`);
  }
}

function sanitizePdfFilename(url) {
  try {
    const pathname = new URL(url).pathname || "/";
    const raw = pathname.split("/").pop() || `idx-disclosure-${Date.now()}.pdf`;
    return raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  } catch {
    return `idx-disclosure-${Date.now()}.pdf`;
  }
}

function getDownloadsBaseDir() {
  const userAgent = navigator.userAgent || "";
  const isWindows = /Win/.test(userAgent);
  const home = (() => {
    if (isWindows) {
      return (chrome?.runtime?.getURL("/") || "C:/").replace(/^file:\/\//, "").replace(/\/+$/, "");
    }
    return "/home";
  })();

  if (isWindows) {
    return `${home.replace(/\\/g, "/")}/Users/Downloads`;
  }
  return `${home.replace(/\\/g, "/")}/Downloads`;
}

async function savePdfToDownloads(arrayBuffer, url, title = "") {
  try {
    const filename = title ? `${title}-${sanitizePdfFilename(url)}` : sanitizePdfFilename(url);
    const dataUrl = `data:application/pdf;base64,${toBase64(arrayBuffer)}`;
    const downloadPath = `idxscrapper/${filename}`;
    const downloadsDir = getDownloadsBaseDir();

    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: downloadPath,
        saveAs: false,
      });
      log(`  Saved PDF to ${downloadsDir}/${downloadPath} (id=${downloadId})`);

      return `${downloadsDir}/${downloadPath}`;
    } catch (e) {
      log(`  Failed to save PDF to Downloads: ${e.message}`, "error");
      return null;
    }
  } catch (e) {
    log(`  PDF save helper failed: ${e.message}`, "error");
    return null;
  }
}

function sanitizeMarkdownFilename(value) {
  return String(value || "idx-analysis")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "idx-analysis";
}

function formatPublishDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return "";

  const months = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const month = months[match[2].toLowerCase()];
  if (!month) return "";
  return `${match[3]}${month}${match[1].padStart(2, "0")}`;
}

async function saveMarkdownToDownloads(content, title, publishDate) {
  const formattedDate = formatPublishDate(publishDate);
  const now = new Date();
  const fallbackDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const resultFolder = formattedDate || fallbackDate;
  const filename = `${sanitizeMarkdownFilename(`${resultFolder} ${title}`)}.md`;
  const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
  const downloadPath = `idxscrapperresult/${resultFolder}/${filename}`;
  log(`💾 Saving Markdown result to Downloads/${downloadPath}...`);
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: downloadPath,
      saveAs: false,
      conflictAction: "uniquify",
    });
    log(`⛔ Saved Markdown result to Downloads/${downloadPath} (id=${downloadId})`);
  } catch (e) {
    log(`⛔ Failed to save Markdown result: ${e.message}`, "error");
    throw e;
  }
}

async function fetchPdfText(url, title = "", maxRetries = 3) {
  log(`💾 Fetching PDF from ${url}...`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { credentials: "include" });
    //   log(`  Attempt ${attempt} ${url} -> ${resp.status} (${resp.headers.get("content-type") || "?"})`);
      if (resp.status === 403) { await sleep(3000); continue; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    //   log(` PDF Downloaded ${resp.headers.get("content-length") || "?"} bytes`);
      const buf = await resp.arrayBuffer();
      const magic = new TextDecoder().decode(buf.slice(0, 5));
      log(`💾 Validating PDF with magic`);
      if (!magic.startsWith("%PDF")) throw new Error("Not a valid PDF (possible block/challenge page)");
      log(`💾 PDF magic validated, ${buf.byteLength} bytes`);
      log(`💾 PDF downloaded ${buf.byteLength} bytes, saving to Downloads and extracting text...`);
      const savedPath = await savePdfToDownloads(buf, url, title);
      log(`💾 Saved PDF to Downloads: ${savedPath || "failed"}`);
      if (!savedPath) return null;

      let result = null;
      try {
        result = await extractPdfTextFromFile(savedPath);
      } catch (e) {
        log(`⛔ Falling back to in-memory PDF buffer because local file read is blocked: ${e.message}`, "error");
        result = await extractPdfTextFromBuffer(buf);
      }

      log(`💾 Extracted text length: ${result ? result.length : "?"} chars`);
      return result;
    } catch (e) {
    //   log(`  Attempt ${attempt} failed: ${e.message}`, "error");
      if (attempt < maxRetries) await sleep(3000);
    }
  }
  return null;
}

// ================= AI + Discord =================
async function callOpenRouter(prompt, apiKey, model, timeoutMs = 120000) {
  log(`🤖 Calling OpenRouter with model ${model}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    log(`⛔ OpenRouter request timed out after ${timeoutMs}ms`, "error");
    return controller.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        reasoning: { enabled: true },
      }),
      signal: controller.signal,
    });
    log(`🤖 OpenRouter response: ${resp.status} (${resp.headers.get("content-type") || "?"})`);
  if (resp.status === 403) {
    log("⛔ OpenRouter: 403 Forbidden (check your API key)", "error");
    throw new Error("OpenRouter: 403 Forbidden (check your API key)");
  }
  if (resp.status === 429) {
    log("⛔ OpenRouter: 429 Too Many Requests (rate limit exceeded)", "error");
    throw new Error("OpenRouter: 429 Too Many Requests (rate limit exceeded)");
  }
    if (!resp.ok) {
      log(`⛔ OpenRouter error ${resp.status}: ${await resp.text()}`, "error");
      throw new Error(`OpenRouter error ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    log(`🤖 OpenRouter response JSON: ${JSON.stringify(data).slice(0, 200)}...`);
    return data.choices?.[0]?.message ?? {};
  } catch (e) {
    if (e.name === "AbortError") {
      log(`⛔ OpenRouter request timed out after ${timeoutMs}ms`, "error");
      throw new Error(`OpenRouter request timed out after ${timeoutMs}ms`);
    }
    log(`⛔ OpenRouter request failed: ${e.message}`, "error");
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendToDiscord(content, reasoningText, webhookUrl) {
  if (!webhookUrl) { log("  No Discord webhook configured, skipping send", "error"); return; }
  log(`🚀  Sending to Discord webhook...`);
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify({ content }));
//   if (reasoningText) {
//     fd.append("files[0]", new Blob([`AI Reasoning:\n${reasoningText}\n`], { type: "text/plain" }), "ai_reasoning.txt");
//   }
  const resp = await fetch(webhookUrl, { method: "POST", body: fd });
  if (resp.status !== 204 && resp.status !== 200) {
    log(`  Discord error ${resp.status}: ${await resp.text()}`, "error");
    throw new Error(`Discord error ${resp.status}: ${await resp.text()}`);
  }
}

// ================= Main scrape run =================
async function runScrape(dateFrom, dateTo) {
  const heartbeat = startScrapeHeartbeat();
  const settings = await chrome.storage.local.get(["apiKey", "webhookUrl", "model", "saveToFile", "cache"]);
  const apiKey = settings.apiKey;
  const webhookUrl = settings.webhookUrl;
  const model = settings.model || "nex-agi/nex-n2.5-pro:free";
  const saveToFile = Boolean(settings.saveToFile);
  const cache = settings.cache || {};

  if (!apiKey) {
    log("❌ Set your OpenRouter API key in settings first!", "error");
    heartbeat.stop();
    return;
  }

  const dateRange = `${dateFrom} ~ ${dateTo}`;
  heartbeat.setStage(`opening IDX disclosures for ${dateRange}`);
  log(`[v0.11] Opening IDX disclosures: ${dateRange}`);

  // --- open IDX in the current tab, or fall back to creating one if needed ---
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = currentTab?.id ?? (await chrome.tabs.create({ url: IDX_URL, active: true })).id;
  heartbeat.setStage("waiting for IDX tab to load");
  await chrome.tabs.update(tabId, { url: IDX_URL, active: true });
  await waitForTabLoad(tabId);
  await sleep(3000);

  await chrome.scripting.executeScript({ target: { tabId }, func: selectFilterOption });
  await sleep(3000);

  await chrome.scripting.executeScript({
    target: { tabId }, func: setDateFilter, args: [dateRange],
  });
  await sleep(3000);

  // --- paginate & collect cards ---
  heartbeat.setStage("scraping announcement pages");
  const allCards = [];
  let pageNum = 1;
  while (true) {
    const [{ result: cards }] = await chrome.scripting.executeScript({
      target: { tabId }, func: scrapeCardsInPage,
    });
    allCards.push(...cards);
    log(`Page ${pageNum}: ${cards.length} cards`);

    const [{ result: hasNext }] = await chrome.scripting.executeScript({
      target: { tabId }, func: clickNextInPage,
    });
    if (!hasNext) break;
    pageNum++;
    await sleep(3000);
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  log(`Total: ${allCards.length} announcements. Starting analysis...`);

  // --- process each card ---
  let processed = 0;
  for (const card of allCards) {
    heartbeat.setStage(`processing ${processed + 1}/${allCards.length}: ${card.title}`);
    log(`Processing: [${card.publishDate}] ${card.title}`);
    let prompt = buildPrompt(card.title);
    if (card.pdfUrl && cache[card.pdfUrl]) prompt = ""; // already done
    log(`💬 Prompt: ${prompt ? prompt : cache[card.pdfUrl] ? "(skipped, already cached)" : "(skipped, no prompt rule)"}`);
    if (!prompt) continue;

    log(`📈 [${card.ticker || "?"}] ${card.title}`);

    let pdfContent = await fetchPdfText(card.pdfUrl, card.title);
    log(`  PDF content length: ${pdfContent ? pdfContent.length : "?"} chars`);
    if (pdfContent === null) { log("  Skipped: could not download PDF", "error"); continue; }

    for (const link of card.links) {
      if (link.url.toLowerCase().endsWith(".pdf")) {
        const extra = await fetchPdfText(link.url, card.title);
        if (extra) pdfContent += ". content pengumuman selanjutnya: " + extra;
      }
    }

    const fullPrompt =
      `buatkan json dalam format yang valid. hanya json yang dihasilkan, tidak ada penjelasan lain. ` +
      `Berikut adalah dokumen pengumuman dari IDX: content: ${pdfContent}. ${prompt}`;

    log(`💬 Full prompt length: ${fullPrompt.length} chars`);
    let message;
    heartbeat.setStage(`waiting for AI response for ${card.title}`);
    log(`🤖 Trying OpenRouter call with model ${model}...`);
    try {
      message = await callOpenRouter(fullPrompt, apiKey, model);
    } catch (e) {
      log(`  AI call failed: ${e.message}`, "error");
      continue;
    }

    const content = message.content || "";
    const reasoning = message.reasoning_details || message.reasoning || "";
    const pdfLinks = card.links.filter((l) => l.url.toLowerCase().endsWith(".pdf")).map((l) => l.url).join("\n");

    const discordMsg =
      `\n\n**[${card.publishDate}] ${card.title}**\n~~------------------~~\n` +
      `${discordMessageFormatter(content)}\n` +
      `~~------------------~~\n${card.pdfUrl}\n${pdfLinks}\n~~------------------~~`;

    const markdownResult =
      `# ${card.title}\n\n` +
      `**Published:** ${card.publishDate || "Unknown"}\n\n` +
      `${discordMessageFormatter(content)}\n\n` +
      `## Source documents\n\n` +
      `- ${card.pdfUrl}\n` +
      (pdfLinks ? `${pdfLinks.split("\n").map((link) => `- ${link}`).join("\n")}\n` : "");

    try {
      heartbeat.setStage(`saving result for ${card.title}`);
      if (saveToFile) {
        await saveMarkdownToDownloads(markdownResult, card.title, card.publishDate);
      } else {
        log(`🚀 Sending Discord message length: ${discordMsg.length} chars`);
        if (discordMsg.length > 1900) {
          await sendToDiscord(discordMsg.slice(0, 1900), reasoning, webhookUrl);
          await sendToDiscord(discordMsg.slice(1900), reasoning, webhookUrl);
        } else {
          await sendToDiscord(discordMsg, reasoning, webhookUrl);
        }
      }
    } catch (e) {
      log(`  ${saveToFile ? "Markdown save" : "Discord send"} failed: ${e.message}`, "error");
    }

    if (card.pdfUrl) cache[card.pdfUrl] = true; // replaces SQLite cache
    processed++;
    log(`  ✅ Done (${processed} analyzed)`);
  }

  await chrome.storage.local.set({ cache });
  heartbeat.stop();
  log(`🎉 Finished! ${processed} new announcements analyzed.`, "success");
  try { chrome.runtime.sendMessage({ type: "DONE" }); } catch {}
}

// ================= Message listener =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CHECK_UPDATE") {
    fetch(UPDATE_CHECK_URL)
      .then(async (response) => {
        log(`Checking for update: ${response.status} (${response.headers.get("content-type") || "?"})`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        sendResponse({ ok: true, isUpdateAvailable: result.is_update_available === true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "START") {
    runScrape(msg.dateFrom, msg.dateTo).catch((e) => {
      activeHeartbeat?.stop();
      log(`Fatal: ${e.message}`, "error");
    });
    sendResponse({ ok: true });
  }
});