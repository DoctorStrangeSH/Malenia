/* Configure one explicitly selected current tab; never enumerate all tabs. */
(() => {
  const button=document.getElementById('useActiveSource');
  const roleSelect=document.getElementById('activeSourceRole');
  const title=document.getElementById('activeSourceTitle');
  const status=document.getElementById('activeSourceStatus');
  const roles=['inventory','datalens','asgard'];
  const labels={inventory:'Инвентаризация',datalens:'DataLens',asgard:'Asgard'};
  let active=null;
  const show=text=>{status.textContent=text;};
  const clean=url=>MaleniaAutomation.sourceUrl(url);
  function summary(targets){
    return roles.map(role=>labels[role]+': '+(targets?.[role]?'сохранён ✓':'нужно выбрать')).join(' · ');
  }
  chrome.storage.local.get('maleniaTargets').then(data=>show(summary(data?.maleniaTargets)))
    .catch(()=>show('Не удалось прочитать сохранённые источники.'));
  chrome.tabs.query({active:true,lastFocusedWindow:true}).then(tabs=>{
    const tab=tabs[0];clean(tab?.url);active=tab;
    title.textContent=String(tab.title||new URL(tab.url).hostname).slice(0,120);
    const host=new URL(tab.url).hostname;
    roleSelect.value=host==='docs.google.com'&&/^\/spreadsheets\/d\//.test(new URL(tab.url).pathname)?'inventory':host==='datalens.yandex-team.ru'?'datalens':
      host==='asgard.market.yandex-team.ru'?'asgard':'';
    button.disabled=false;
  }).catch(()=>{title.textContent='Открой рабочую HTTPS-вкладку и нажми расширение на ней.';});
  button.addEventListener('click',async()=>{
    if(!active||!roles.includes(roleSelect.value)){show('Выбери назначение этой вкладки.');return;}
    button.disabled=true;
    try{
      const role=roleSelect.value,url=clean(active.url);
      // Request within the click handler, before awaiting other operations.
      const allowed=await chrome.permissions.request({origins:[new URL(url).origin+'/*']});
      if(!allowed){show('Доступ не предоставлен. Источник не сохранён.');return;}
      const response=await chrome.runtime.sendMessage({type:'configure_active_source',role,url});
      if(!response?.ok)throw Error('save_failed');
      show(labels[role]+' сохранён. '+summary(response.targets));
      try{
        const shared=await sendNativeMessage({type:'share_active_tab',request_id:crypto.randomUUID(),tab:sanitizedTab(active)});
        if(!shared?.ok)throw Error('share_failed');
      }catch{show(labels[role]+' сохранён в расширении. Передача вкладки в приложение не подтверждена — проверь соединение с Маленией.');}
    }catch{show('Не удалось сохранить источник. Проверь соединение с расширением и повтори.');}
    finally{button.disabled=false;}
  });
})();
