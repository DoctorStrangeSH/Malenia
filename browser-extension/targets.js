/* Explicit one-time setup for the read-only order-checking skill. */
(() => {
  const fields = {
    inventory: document.getElementById("targetInventory"),
    datalens: document.getElementById("targetDatalens"),
    asgard: document.getElementById("targetAsgard"),
  };
  const button = document.getElementById("saveTargets");
  const status = document.getElementById("targetsStatus");
  const orderStatus = document.getElementById("orderAuditStatus");
  const discover = document.getElementById("discoverTargets");
  const selectors = Object.fromEntries(Object.keys(fields).map(role =>
    [role, document.getElementById("select" + role)]));
  const reasons = {
    search_field_missing:"Не найдено поле поиска: проверь вход и рабочую страницу",
    search_field_ambiguous:"Найдено несколько подходящих полей поиска",
    search_filters_not_empty:"В Asgard заполнены другие фильтры: очисти их и продолжи разбор",
    search_button_missing:"Не найдена доступная кнопка «Найти»",
    search_button_ambiguous:"Найдено несколько кнопок «Найти»",
    search_navigation_ambiguous:"Не удалось однозначно выбрать нужную вкладку сервиса",
    search_results_unconfirmed:"За 15 секунд не получен однозначный обновлённый результат поиска",
    search_origin_mismatch:"Проверь вход: сервис перенаправил на другой адрес",
    page_timeout:"Страница не загрузилась вовремя",
    invalid_inventory_search_keys:"Не удалось определить грузоместо для поиска",
    unmapped_search_form:"На странице не найдено подходящее поле поиска",
    unsupported_search_form:"Поиск устроен иначе, чем поддерживает адаптер",
    dynamic_search_ui:"Найден динамический поиск — нужен адаптер страницы",
    unsupported_dynamic_search:"Динамический поиск не удалось подтвердить",
    dynamic_search_no_result_update:"Таблица не обновилась после поиска",
    dynamic_search_unchanged_table:"Таблица не изменилась после поиска",
    unmapped_search_results:"Не удалось распознать таблицу результатов",
    unverified_search_result_identity:"Результат не совпал с искомым грузоместом",
    changed_search_schema:"Колонки таблицы изменились при поиске",
    virtualized_or_incomplete_grid:"Таблица неполная или использует виртуальную прокрутку",
    navigation_outside_allowed_origin:"Страница перенаправила на другой сайт",
    pagination_limit:"Не удалось безопасно прочитать все страницы",
    too_many_search_rows:"Превышен предел результатов поиска",
    native_host_rejected:"Локальное ядро отклонило данные страницы",
    reconciliation_unavailable:"Не удалось сверить данные источников: нужно подтвердить колонки",
    site_or_browser_error:"Ошибка при чтении сайта или браузера",
  };
  const steps={
    page_changed:"Страница перешла на другой адрес",
    input_setter_unavailable:"Не удалось установить значение поля",
    input_value_reset:"Поле не приняло номер до отправки поиска",
    input_changed_after_submit:"После отправки поиска поле не восстановило искомый номер за время ожидания",
    input_handler_failed:"Обработчик ввода страницы завершился ошибкой",
    input_handler_unavailable:"Номер не принят; обработчик ввода страницы недоступен",
    input_replaced_before_submit:"Страница заменила поле во время ввода; поиск не отправлен",
    result_wait_timeout:"Ожидание обновлённой таблицы завершилось без подтверждённого результата",
  };
  function renderAudit(audit) {
    if (!orderStatus || !audit || !Array.isArray(audit.results)) return;
    const labels = {inventory:"ИНВента",datalens:"DataLens",asgard:"Asgard"};
    const items = audit.results.map(item => {
      const source = labels[item.role];
      if (!source) return null;
      return item.status === "needs_attention" ?
        source+": "+(item.step?.startsWith("input_")?"Не подтверждено значение поля поиска":
          reasons[item.reason] || "Требуется проверка совместимости")+
          (steps[item.step]?" · "+steps[item.step]:"")+
          (item.review_available===true?" · Страница ошибки оставлена открытой в браузере":"")+
          (item.surface && ['visible_inputs','editable_inputs','bound_inputs','matched_inputs'].every(key=>
            Number.isInteger(item.surface[key]) && item.surface[key]>=0 && item.surface[key]<=10000)?
            ` [Вкладка разбора: видимых полей ${item.surface.visible_inputs}, доступных ${item.surface.editable_inputs}, в блоке №13 ${item.surface.bound_inputs}, совпадений ${item.surface.matched_inputs}]`:"") :
        source+": чтение завершено";
    }).filter(Boolean);
    const end = audit.phase === "reconciled" ? "Сверка выполнена без изменений сайтов." :
      audit.phase === "read_only" ? (reasons[audit.reason] || "Только чтение: сверка не подтверждена") :
      audit.phase === "needs_attention" ? "Автоматическая проверка не завершена." : "Проверка выполняется…";
    const version=typeof audit.bridge_version==='string' && /^\d+\.\d+\.\d+$/.test(audit.bridge_version)?
      "Browser Bridge "+audit.bridge_version:null;
    orderStatus.textContent = [version,...items,end].filter(Boolean).join(" · ");
    orderStatus.className = "status"+(audit.phase === "reconciled" ? " ok" : "");
  }
  chrome.storage.session?.get("maleniaAudit").then(data => renderAudit(data?.maleniaAudit)).catch(()=>{});
  chrome.storage.onChanged?.addListener((changes,area) => {
    if (area === "session" && changes.maleniaAudit) renderAudit(changes.maleniaAudit.newValue);
  });
  const show = (message, kind = "") => {
    status.textContent = message;
    status.className = "status" + (kind ? " " + kind : "");
  };
  discover?.addEventListener("click", async () => {
    discover.disabled = true;
    try {
      const tabs = await chrome.tabs.query({});
      const pages = new Map();
      for (const tab of tabs) {
        try {
          const url = new URL(tab.url);
          const clean = MaleniaAutomation.sourceUrl(tab.url);
          // Validate each candidate with the same rules as saved targets.
          MaleniaAutomation.normalizeTargets(Object.fromEntries(
            Object.keys(fields).map(role => [role, clean])));
          if (url.username || url.password) continue;
          if (!pages.has(clean)) pages.set(clean, {url:clean,
            title:String(tab.title || url.hostname).slice(0,120)});
        } catch { /* Internal browser pages and unsafe targets are omitted. */ }
      }
      const candidates = [...pages.values()].slice(0,100);
      for (const role of Object.keys(fields)) {
        const select = selectors[role];
        select.replaceChildren();
        const blank = document.createElement("option");
        blank.value = ""; blank.textContent = "Выберите открытую вкладку…";
        select.append(blank);
        for (const page of candidates) {
          const option = document.createElement("option");
          option.value = page.url;
          option.textContent = page.title + " · " + new URL(page.url).hostname;
          select.append(option);
        }
        const matching = candidates.filter(page => {
          const url = new URL(page.url);
          return role === "inventory" ? url.hostname === "docs.google.com" && /^\/spreadsheets\/d\/[^/]+\/edit\/?$/.test(url.pathname) :
            url.hostname === (role === "datalens" ? "datalens.yandex-team.ru" : "asgard.market.yandex-team.ru");
        });
        const selected = pages.has(fields[role].value) ? fields[role].value : matching.length === 1 ? matching[0].url : "";
        select.value = selected;
        fields[role].value = selected;
      }
      show(candidates.length ? Object.values(fields).every(field=>field.value) ? "Рабочие вкладки определены. Нажми «Сохранить и разрешить чтение», затем вернись в Малению и продолжи разбор." : "Выбери недостающие рабочие вкладки и нажми «Сохранить и разрешить чтение». Содержимое страниц ещё не читается." :
        "Открой рабочие HTTPS-вкладки в этом браузере и повтори поиск.");
    } catch { show("Не удалось получить список вкладок. Повтори поиск.", "error"); }
    finally { discover.disabled = false; }
  });
  for (const role of Object.keys(fields)) {
    selectors[role]?.addEventListener("change", () => { fields[role].value = selectors[role].value; });
  }
  const normalize = () => MaleniaAutomation.normalizeTargets(
    Object.fromEntries(Object.entries(fields).map(([role, field]) => [role, field.value.trim()])));
  chrome.storage.local.get("maleniaTargets").then(saved => {
    if (!saved?.maleniaTargets) return;
    try {
      let count=0;
      for (const role of Object.keys(fields)) {
        if(!saved.maleniaTargets[role])continue;
        fields[role].value=MaleniaAutomation.normalizeTargets(Object.fromEntries(
          Object.keys(fields).map(key=>[key,saved.maleniaTargets[role]])))[role];
        count++;
      }
      show(count===3?"Источники сохранены. Можно запускать разбор в Малении.":`Сохранено источников: ${count} из 3. Подключи остальные прямо с их вкладок.`,count===3?"ok":"");
    } catch { show("Сохранённые адреса требуют повторной настройки.", "error"); }
  }).catch(() => show("Не удалось прочитать настройки браузера.", "error"));
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const targets = normalize();
      const allowed = await chrome.permissions.request({origins:MaleniaAutomation.origins(targets)});
      if (!allowed) {
        show("Разрешения не предоставлены. Адреса не сохранены.", "error");
        return;
      }
      await chrome.storage.local.set({maleniaTargets: targets, maleniaExactGetSearch:true});
      try { await chrome.runtime?.sendMessage?.({type:"poll_desktop_audit"}); } catch { /* periodic poll remains available */ }
      show("Готово! Запусти «Проверить первый заказ» в Малении.", "ok");
    } catch {
      // Never expose rejected URLs, credentials, or browser exception text.
      show("Проверь три HTTPS-адреса без параметров, фрагментов и встроенных паролей.", "error");
    } finally { button.disabled = false; }
  });
})();
