import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, FolderOpen, Globe2, LoaderCircle } from "lucide-react";

type Setup = {available:boolean;saved_extension_id:string|null};
export function BrowserSetup() {
  const [setup,setSetup]=useState<Setup|null>(null);
  const [extensionId,setExtensionId]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const pending=useRef(false);
  useEffect(()=>{
    let active=true;
    invoke<Setup>("get_browser_bridge_setup").then(result=>{
      if(active){setSetup(result);setExtensionId(result.saved_extension_id||"");}
    }).catch(()=>{if(active)setError("Не удалось проверить файлы расширения. Повторно откройте раздел или переустановите Малению.");});
    return()=>{active=false;};
  },[]);
  const openFolder=async()=>{
    setError("");
    try{await invoke("open_browser_extension_folder");}
    catch(reason){setError(String(reason));}
  };
  const register=async()=>{
    const id=extensionId.trim();
    if(pending.current||!setup?.available||!/^[a-p]{32}$/.test(id))return;
    if(setup.saved_extension_id&&setup.saved_extension_id!==id&&
      !window.confirm("Заменить сохранённый ID расширения? Связь будет разрешена для нового ID."))return;
    pending.current=true;setBusy(true);setError("");setNotice("");
    try{
      await invoke("register_browser_bridge",{extensionId:id});
      setSetup({...setup,saved_extension_id:id});
      setNotice("Регистрация завершена. Перезапустите Яндекс Браузер, откройте расширение Малении и проверьте подключение.");
    }catch(reason){setError(String(reason));}
    finally{pending.current=false;setBusy(false);}
  };
  return <article className="panel browser-setup" aria-labelledby="browser-setup-title">
    <div className="workbench-heading"><div><div className="eyebrow">ДЛЯ РАБОТЫ С БРАУЗЕРОМ</div><h2 id="browser-setup-title"><Globe2 size={22}/>Подключить расширение</h2><p>Расширение уже входит в установщик. Настройте связь один раз для своего браузера.</p></div><span className="workbench-status">{setup?.saved_extension_id?"ID сохранён":"Первое подключение"}</span></div>
    {setup&&!setup.available?<p className="alert error" role="alert">В этой установке нет полного комплекта расширения. Установите свежую версию Малении.</p>:null}
    {error?<p className="alert error" role="alert">{error}</p>:null}
    {notice?<p className="alert success" role="status"><Check size={16}/>{notice}</p>:null}
    <ol className="browser-setup-steps">
      <li><div><b>Загрузите расширение в Яндекс Браузер</b><p>Откройте управление расширениями, включите режим разработчика и выберите загрузку распакованного расширения. Укажите папку, которую откроет кнопка.</p></div><button className="secondary" disabled={!setup?.available||busy} onClick={()=>void openFolder()}><FolderOpen size={17}/>Открыть папку расширения</button></li>
      <li><div><b>Скопируйте ID установленного расширения</b><p>Откройте расширение. Если связь ещё не настроена, оно покажет ID этого браузера. Скопируйте его сюда.</p></div><label>ID расширения<input value={extensionId} maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} onChange={event=>setExtensionId(event.target.value)} placeholder="32 строчные буквы от a до p"/><small>{extensionId&&!/^[a-p]{32}$/.test(extensionId.trim())?"Проверьте ID: нужны ровно 32 строчные буквы от a до p.":"ID разрешает этому расширению связь с Маленией."}</small></label></li>
      <li><div><b>Зарегистрируйте связь</b><p>Маления настроит связь для текущего пользователя Windows. Затем перезапустите браузер и откройте расширение.</p></div><button className="primary" disabled={!setup?.available||busy||!/^[a-p]{32}$/.test(extensionId.trim())} onClick={()=>void register()}>{busy?<LoaderCircle className="spin" size={17}/>:<Check size={17}/>}Настроить связь с браузером</button></li>
    </ol>
    <p className="setup-footnote">Сохранённый ID ещё не подтверждает работу расширения и доступ к сайтам. На каждой нужной рабочей странице откройте расширение и нажмите «Использовать эту вкладку».</p>
  </article>;
}
