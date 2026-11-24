import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, FolderOpen, Globe2, LoaderCircle, RefreshCw } from "lucide-react";

type Setup = {available:boolean;saved_extension_id:string|null;bundled_extension_id?:string};

/** Connection is automatic: the extension has a fixed ID, Malenia registers the
 *  native host on start, and when a browser policy blocks native hosts the
 *  extension talks to the running app directly. Manual ID is only for old copies. */
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
      if(active){setSetup(result);setExtensionId(result.saved_extension_id||result.bundled_extension_id||"");}
    }).catch(()=>{if(active)setError("Не удалось проверить файлы расширения. Повторно откройте раздел или переустановите Малению.");});
    return()=>{active=false;};
  },[]);
  const openFolder=async()=>{
    setError("");
    try{await invoke("open_browser_extension_folder");}
    catch(reason){setError(String(reason));}
  };
  const register=async(idOverride?:string)=>{
    const id=(idOverride??extensionId).trim();
    if(pending.current||!setup?.available||!/^[a-p]{32}$/.test(id))return;
    if(setup.saved_extension_id&&setup.saved_extension_id!==id&&
      !window.confirm("Заменить сохранённый ID расширения? Связь будет разрешена для нового ID."))return;
    pending.current=true;setBusy(true);setError("");setNotice("");
    try{
      await invoke("register_browser_bridge",{extensionId:id});
      setSetup({...setup,saved_extension_id:id});
      setNotice("Регистрация завершена. Полностью закройте Яндекс Браузер (и в трее) и откройте снова.");
    }catch(reason){setError(String(reason));}
    finally{pending.current=false;setBusy(false);}
  };
  const bundled=setup?.bundled_extension_id;
  return <article className="panel browser-setup" aria-labelledby="browser-setup-title">
    <div className="workbench-heading"><div><h2 id="browser-setup-title"><Globe2 size={22}/>Подключить расширение</h2><p>Расширение уже входит в Малению. Связь настраивается автоматически — вводить ничего не нужно.</p></div><span className="workbench-status">Автоматически</span></div>
    {setup&&!setup.available?<p className="alert error" role="alert">В этой установке нет полного комплекта расширения. Установите свежую версию Малении.</p>:null}
    {error?<p className="alert error" role="alert">{error}</p>:null}
    {notice?<p className="alert success" role="status"><Check size={16}/>{notice}</p>:null}
    <ol className="browser-setup-steps">
      <li><div><b>Добавьте расширение в Яндекс Браузер</b><p>Откройте адрес <code>browser://extensions</code>, включите «Режим разработчика», нажмите «Загрузить распакованное расширение» и выберите папку, которую откроет кнопка. Если раньше стояла старая версия — сначала удалите её.</p></div><button className="secondary" disabled={!setup?.available||busy} onClick={()=>void openFolder()}><FolderOpen size={17}/>Открыть папку расширения</button></li>
      <li><div><b>Откройте расширение</b><p>Нажмите на значок Малении в браузере. Пока Маления запущена, расширение подключится само — даже если на компьютере действуют ограничения организации.</p></div></li>
      <li><div><b>Выберите рабочие вкладки</b><p>На странице инвентаризации, DataLens и Asgard откройте расширение и нажмите «Использовать эту вкладку». Это делается один раз для каждого сервиса.</p></div></li>
    </ol>
    <details className="advanced-setup">
      <summary>Дополнительно: если расширение пишет, что Маления не найдена</summary>
      <p>Сначала убедитесь, что приложение Маления открыто, и нажмите в расширении «Проверить снова». Если не помогло — настройте связь заново. ID нужно менять только для старой копии расширения.</p>
      <div className="advanced-row">
        <button className="secondary" disabled={!setup?.available||busy||!bundled} onClick={()=>void register(bundled)}>{busy?<LoaderCircle className="spin" size={17}/>:<RefreshCw size={17}/>}Настроить связь заново</button>
      </div>
      <label>ID расширения<input value={extensionId} maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} onChange={event=>setExtensionId(event.target.value)} placeholder="32 строчные буквы от a до p"/><small>{extensionId&&!/^[a-p]{32}$/.test(extensionId.trim())?"Проверьте ID: нужны ровно 32 строчные буквы от a до p.":bundled&&extensionId.trim()===bundled?"Это ID встроенного расширения — менять не нужно.":"Свой ID нужен только для старой копии расширения."}</small></label>
      <button className="secondary" disabled={!setup?.available||busy||!/^[a-p]{32}$/.test(extensionId.trim())} onClick={()=>void register()}>{busy?<LoaderCircle className="spin" size={17}/>:<Check size={17}/>}Настроить связь с браузером</button>
    </details>
  </article>;
}
