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
    inventa_writeback_required:"Для записи результатов обнови Малению и Browser Bridge",
    inventa_writeback_failed:"Не удалось записать отметки в инвентаризацию; позиция не сдвинута",
    inventa_writeback_source_changed:"Лист или строки инвентаризации изменились; запись остановлена",
    inventa_writeback_formula_protected:"В колонке статуса обнаружена формула; запись остановлена",
    inventa_writeback_reauthorization_required:"Нужно заново подключить Google Sheets в Малении",
    inventa_writeback_permission_denied:"Google не разрешил редактирование выбранного листа",
    inventa_writeback_verification_failed:"Google не подтвердил статус и зелёную заливку; проверь отметки",
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
    input_loading_timeout:"Фильтр DataLens не завершил загрузку; поиск не отправлен",
    input_value_reset:"Поле не приняло номер до отправки поиска",
    input_changed_after_submit:"После отправки поиска поле не восстановило искомый номер за время ожидания",
    input_handler_failed:"Обработчик ввода страницы завершился ошибкой",
    input_handler_unavailable:"Номер не принят; обработчик ввода страницы недоступен",
    input_replaced_before_submit:"Страница заменила поле во время ввода; поиск не отправлен",
    scan_row_limit:"История сканов превышает лимит чтения в 1000 строк",
    scan_header_ambiguous:"Обязательная колонка истории встречается несколько раз",
    scan_row_width:"Число ячеек строки не совпало с числом колонок",
    scan_cell_limit:"Значение обязательного поля истории длиннее 256 символов",
    scan_history_widget_missing:"Не удалось определить блок «История сканов по заказу»",
    scan_empty_unconfirmed:"Ответ «Нет данных» ещё не подтверждён обновлением истории сканов",
    scan_table_missing:"Не найдена таблица с колонками истории сканов",
    scan_table_ambiguous:"Найдено несколько основных таблиц истории сканов",
    scan_table_incomplete:"История сканов превышает лимит или имеет неполные строки",
    scan_table_identity_mismatch:"Грузоместо в истории сканов не совпало с запросом",
    asgard_card_heading:"Не подтверждён заголовок карточки грузоместа",
    asgard_card_box:"Не подтверждён ID грузоместа в карточке",
    asgard_card_history:"Не удалось прочитать отдельную историю изменения статусов",
    asgard_card_status:"Не подтверждён текущий статус карточки",
    asgard_wait_loading:"Asgard не завершил загрузку результата",
    asgard_table_missing:"Не найдена таблица результатов обратного потока",
    asgard_table_ambiguous:"Найдено несколько таблиц результатов обратного потока",
    asgard_table_incomplete:"Таблица обратного потока ещё пуста или имеет неполные строки",
    asgard_input_unconfirmed:"После поиска текущее поле Asgard не содержит искомый ШК",
    asgard_result_not_refreshed:"Не подтверждено обновление результата Asgard после поиска",
    result_wait_timeout:"Ожидание обновлённой таблицы завершилось без подтверждённого результата",
  };
  function scanShapeLabel(shape){
    const fields=['rows','columns','min_cells','max_cells','duplicate_required_headers','max_required_chars'];
    if(!shape || Object.keys(shape).length!==fields.length || !fields.every(key=>
      Number.isInteger(shape[key]) && shape[key]>=0 && shape[key]<=1000000))return '';
    return ` [История: строк ${shape.rows}, колонок ${shape.columns}, ячеек в строке ${shape.min_cells}–${shape.max_cells}, повторов обязательных колонок ${shape.duplicate_required_headers}, длина обязательного поля до ${shape.max_required_chars}]`;
  }
  function renderAudit(audit) {
    if (!orderStatus || !audit || !Array.isArray(audit.results)) return;
    const labels = {inventory:"Инвентаризация",datalens:"DataLens",asgard:"Asgard"};
    const items = audit.results.map(item => {
      const source = labels[item.role];
      if (!source) return null;
      return item.status === "needs_attention" ?
        source+": "+(item.step?.startsWith("input_")?"Не подтверждено значение поля поиска":
          reasons[item.reason] || "Требуется проверка совместимости")+
          (steps[item.step]?" · "+steps[item.step]:"")+scanShapeLabel(item.scan_shape)+
          (item.review_available===true?" · Страница ошибки оставлена открытой в браузере":"")+
          (item.surface && ['visible_inputs','editable_inputs','bound_inputs','matched_inputs'].every(key=>
            Number.isInteger(item.surface[key]) && item.surface[key]>=0 && item.surface[key]<=10000)?
            ` [Вкладка разбора: видимых полей ${item.surface.visible_inputs}, доступных ${item.surface.editable_inputs}, в блоке №13 ${item.surface.bound_inputs}, совпадений ${item.surface.matched_inputs}]`:"") :
        source+": чтение завершено";
    }).filter(Boolean);
    const end = audit.phase === "reconciled" ? (audit.writeback?.verified===true?"Сверка и запись в инвентаризацию завершены.":"Сверка выполнена без изменений сайтов.") :
      audit.phase === "read_only" ? (reasons[audit.reason] || "Только чтение: сверка не подтверждена") :
      audit.phase === "needs_attention" ? "Автоматическая проверка не завершена." : audit.phase === "paused" ? "Задача остановлена." : "Проверка выполняется…";
    const version=typeof audit.bridge_version==='string' && /^\d+\.\d+\.\d+$/.test(audit.bridge_version)?
      "Browser Bridge "+audit.bridge_version:null;
    const written=audit.writeback?.verified===true && Number.isInteger(audit.writeback.written) &&
      audit.writeback.written>=0 && audit.writeback.written<=20?`В инвентаризации отмечено зелёным: ${audit.writeback.written}`:null;
    const asgardWritten=audit.writeback?.verified===true && Number.isInteger(audit.writeback.asgard_written) && audit.writeback.asgard_written>=0 && audit.writeback.asgard_written<=20?`По Asgard обновлено строк: ${audit.writeback.asgard_written}`:null;
    orderStatus.textContent = [version,...items,written,asgardWritten,end].filter(Boolean).join(" · ");
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
  let selectedPages = new Map();
  discover?.addEventListener("click", async () => {
    discover.disabled = true;
    try {
      const tabs = await chrome.tabs.query({});
      const pages = new Map();
      selectedPages = new Map();
      for (const tab of tabs) {
        try {
          const url = new URL(tab.url);
          const clean = MaleniaAutomation.sourceUrl(tab.url);
          // Validate each candidate with the same rules as saved targets.
          MaleniaAutomation.normalizeTargets(Object.fromEntries(
            Object.keys(fields).map(role => [role, clean])));
          if (url.username || url.password) continue;
          if (!pages.has(clean)) selectedPages.set(clean,tab);
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
      show(candidates.length ? Object.values(fields).every(field=>field.value) ? "Рабочие вкладки определены. Нажми «Передать выбранные вкладки и разрешить чтение», затем вернись в Малению и продолжи разбор." : "Выбери недостающие рабочие вкладки и нажми «Передать выбранные вкладки и разрешить чтение». Содержимое страниц ещё не читается." :
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
      const selected=Object.entries(targets).map(([role,url])=>
        selectors[role]?.value===url && selectedPages.get(url));
      if(selected.every(Boolean)){
        try{
          for(const tab of selected){
            const response=await sendNativeMessage({type:"share_active_tab",request_id:crypto.randomUUID(),tab:sanitizedTab(tab)});
            if(!response?.ok)throw Error("share_failed");
          }
        }catch{show("Адреса сохранены. Передача вкладок в Малению прервалась. Проверьте подключение и повторите.", "error");return;}
        show("Три вкладки переданы. Откройте инвентаризацию в Малении.", "ok");
      }else show("Готово. Адреса сохранены. Чтобы передать вкладки в Малению, выберите их через поиск открытых вкладок.");
    } catch {
      // Never expose rejected URLs, credentials, or browser exception text.
      show("Проверь три HTTPS-адреса без параметров, фрагментов и встроенных паролей.", "error");
    } finally { button.disabled = false; }
  });
})();
