/* Malenia's own work tab: she opens, reads, types and clicks like a person,
 * but only on sites the user has granted to this extension, and never presses
 * buttons that change data. Commands come from the Malenia app on loopback. */
const MaleniaBrowser = (() => {
  const TAB_KEY = "maleniaAgentTab";
  const RISKY = "удал|сохран|подтверд|измени|изменить|отмен|оформ|оплат|списа|заблок|закрыть|архив|переда|назнач|resolve|delete|remove|save|submit|confirm|cancel|apply|approve|применить|отправить";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function originPattern(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/*`;
  }

  async function allowed(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== "https:") return false;
    try { return await chrome.permissions.contains({origins: [originPattern(url)]}); } catch { return false; }
  }

  async function workTab() {
    const stored = await chrome.storage.session.get(TAB_KEY);
    const id = stored?.[TAB_KEY];
    if (typeof id !== "number") return null;
    try { return await chrome.tabs.get(id); } catch { return null; }
  }

  async function waitLoad(tabId, timeout = 30000) {
    const end = Date.now() + timeout;
    await sleep(300);
    while (Date.now() < end) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") { await sleep(1200); return tab; }
      await sleep(250);
    }
    return chrome.tabs.get(tabId);
  }

  // ---- functions injected into the page -------------------------------
  function snapshotInPage(focus) {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = value => String(value || "").replace(/\s+/g, " ").trim();
    const labelOf = el => clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") ||
      (el.closest("label") && el.closest("label").innerText) || "");
    document.querySelectorAll("[data-malenia-ref]").forEach(el => el.removeAttribute("data-malenia-ref"));
    const elements = [];
    let ref = 0;
    const selector = "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=tab],[role=link],[role=menuitem],[role=option]";
    for (const el of document.querySelectorAll(selector)) {
      if (elements.length >= 150) break;
      if (!visible(el)) continue;
      ref += 1;
      el.setAttribute("data-malenia-ref", String(ref));
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const kind = tag === "a" || role === "link" ? "link" : ["input", "textarea", "select"].includes(tag) ? "field" : "button";
      const item = {ref, kind, label: (kind === "field" ? labelOf(el) : clean(el.innerText) || labelOf(el)).slice(0, 80)};
      if (kind === "field") item.value = clean(el.value).slice(0, 80);
      if (kind === "link" && el.href) item.href = String(el.href).slice(0, 200);
      elements.push(item);
    }
    let text = (document.body ? document.body.innerText : "").replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
    if (focus) {
      const words = focus.toLowerCase().split(/\s+/).filter(word => word.length > 1);
      const lines = text.split("\n");
      const keep = new Set();
      lines.forEach((line, index) => {
        const low = line.toLowerCase();
        if (words.some(word => low.includes(word))) for (let k = index - 3; k <= index + 8; k++) keep.add(k);
      });
      if (keep.size) text = [...keep].filter(i => i >= 0 && i < lines.length).sort((a, b) => a - b).map(i => lines[i]).join("\n");
    }
    const max = 9000;
    return {url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max, elements};
  }

  function typeInPage(ref, value, submit) {
    const el = document.querySelector(`[data-malenia-ref="${ref}"]`);
    if (!el) return {error: "element_not_found"};
    el.focus();
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find(o => o.text.trim() === value || o.value === value);
      if (!option) return {error: "option_not_found"};
      el.value = option.value;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event("input", {bubbles: true}));
    el.dispatchEvent(new Event("change", {bubbles: true}));
    if (submit) {
      const options = {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true};
      const handled = !el.dispatchEvent(new KeyboardEvent("keydown", options));
      el.dispatchEvent(new KeyboardEvent("keypress", options));
      el.dispatchEvent(new KeyboardEvent("keyup", options));
      if (!handled && el.form && typeof el.form.requestSubmit === "function") {
        try { el.form.requestSubmit(); } catch { /* the page handles Enter itself */ }
      }
    }
    return {ok: true};
  }

  function clickInPage(ref, risky) {
    const el = document.querySelector(`[data-malenia-ref="${ref}"]`);
    if (!el) return {error: "element_not_found"};
    const label = String(el.innerText || el.getAttribute("aria-label") || el.value || "").trim();
    const isLink = el.tagName === "A" || el.getAttribute("role") === "link" || el.getAttribute("role") === "tab";
    // The access form ("Доступ запрещён" + ticket) is the one form Malenia may submit.
    const dialog = el.closest("[role=dialog],.modal,dialog,form");
    const accessForm = dialog && /доступ запрещ|тикет/i.test(dialog.innerText || "");
    if (!isLink && !accessForm && new RegExp(risky, "i").test(label)) return {error: "risky_button"};
    el.scrollIntoView({block: "center"});
    el.click();
    return {ok: true};
  }

  // ---- actions ---------------------------------------------------------
  async function read(tab, focus = "") {
    if (/passport|login|auth|sso/i.test(new URL(tab.url).host + new URL(tab.url).pathname) && !await allowed(tab.url)) return {error: "login_required"};
    if (!await allowed(tab.url)) return {error: "site_not_allowed"};
    const [frame] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: snapshotInPage, args: [focus]});
    return frame?.result || {error: "page_unreadable"};
  }

  async function perform(command) {
    try {
      const args = command.args || {};
      if (command.action === "open") {
        const url = String(args.url || "");
        if (!await allowed(url)) return {error: "site_not_allowed"};
        let tab = await workTab();
        if (tab) await chrome.tabs.update(tab.id, {url});
        else tab = await chrome.tabs.create({url, active: false});
        await chrome.storage.session.set({[TAB_KEY]: tab.id});
        return read(await waitLoad(tab.id));
      }
      const tab = await workTab();
      if (!tab) return {error: "no_work_tab"};
      if (command.action === "read") return read(tab, String(args.focus || ""));
      if (command.action === "back") {
        await chrome.tabs.goBack(tab.id);
        return read(await waitLoad(tab.id));
      }
      if (!await allowed(tab.url)) return {error: "site_not_allowed"};
      const [frame] = await chrome.scripting.executeScript({
        target: {tabId: tab.id},
        func: command.action === "type" ? typeInPage : clickInPage,
        args: command.action === "type" ? [Number(args.ref), String(args.text || ""), args.submit !== false] : [Number(args.ref), RISKY],
      });
      if (frame?.result?.error) return frame.result;
      await sleep(1500);
      return read(await waitLoad(tab.id, 20000));
    } catch (error) {
      return {error: /No tab|closed/i.test(String(error?.message)) ? "no_work_tab" : "browser_error"};
    }
  }

  // ---- long polling the app ------------------------------------------------
  let looping = false;
  async function post(message, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const id = crypto.randomUUID();
      const response = await fetch("http://127.0.0.1:8765/v1/extension/message", {
        method: "POST", headers: {"Content-Type": "application/json"}, cache: "no-store",
        body: JSON.stringify({...message, request_id: id}), signal: controller.signal});
      if (!response.ok) throw new Error("app_unavailable");
      const value = await response.json();
      if (!value || value.request_id !== id) throw new Error("host_protocol");
      return value;
    } finally { clearTimeout(timer); }
  }

  async function loop() {
    if (looping) return;
    looping = true;
    let failures = 0;
    try {
      while (failures < 3) {
        try { await chrome.runtime.getPlatformInfo(); } catch { /* keeps the worker alive */ }
        let command = null;
        try {
          const claimed = await post({type: "claim_browser_command", wait: 20}, 30000);
          if (!claimed?.ok) throw new Error("claim_failed");
          command = claimed.command;
          failures = 0;
        } catch {
          failures += 1;
          await sleep(3000);
          continue;
        }
        if (!command) continue;
        const result = await perform(command);
        try { await post({type: "finish_browser_command", id: command.id, result}, 20000); } catch { /* app restarted */ }
      }
    } finally { looping = false; }
  }

  return {perform, loop, snapshotInPage, typeInPage, clickInPage, RISKY};
})();
if (typeof module !== "undefined") module.exports = MaleniaBrowser;
