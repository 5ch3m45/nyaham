import * as pdfjsLib from "../vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "EXTRACT_PDF") return;

  (async () => {
    try {
      const data = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
      const pdf = await pdfjsLib.getDocument({ data }).promise;

      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(" ") + "\n";
      }
      sendResponse({ ok: true, text });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // async sendResponse
});