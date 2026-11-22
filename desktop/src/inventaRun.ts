export type RunState = {
  phase:"idle"|"waiting"|"running"|"pausing"|"paused"|"completed"|"error";
  processed:number; total:number; source:string; message:string;
};
type Job = {job_id:string;status:string;failure_reason?:string;current_role?:string;failed_role?:string};
type Batch = {job:Job;queued_orders:number;eligible_orders:number;batch_start:number;batch_end?:number;remaining_orders:number};
type Invoke = <T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
export function auditFailureMessage(job:Job):string {
  const writes:Record<string,string>={
    inventa_writeback_required:"Обнови Малению и расширение для записи отметок в инвентаризацию.",
    inventa_writeback_failed:"Не удалось записать отметки в инвентаризацию. Позиция сохранена.",
    inventa_writeback_source_changed:"Выбранный лист или строки изменились. Запись остановлена; начни разбор заново.",
    inventa_writeback_formula_protected:"В колонке статуса есть формула. Маления не перезаписывает её.",
    inventa_writeback_reauthorization_required:"Заново подключи Google Sheets в настройках Малении.",
    inventa_writeback_permission_denied:"Google не разрешил редактирование выбранного листа.",
    inventa_writeback_verification_failed:"Не удалось подтвердить запись статуса и заливки. Проверь отметки в инвентаризации; позиция сохранена.",
  };
  if(writes[job.failure_reason||""])return writes[job.failure_reason!];
  const role=({inventory:"Инвентаризация",datalens:"DataLens",asgard:"Asgard"} as Record<string,string>)[job.failed_role||""]||"Источник";
  const reasons:Record<string,string>={
    search_field_missing:"Не найдено поле поиска. Открой рабочую страницу сервиса и проверь, что вход выполнен.",
    search_field_ambiguous:"Найдено несколько полей поиска. Маления не смогла выбрать нужное.",
    search_filters_not_empty:"В Asgard заполнены другие фильтры. Очисти их, оставив поиск по штрихкоду коробки, и продолжи разбор.",
    search_button_missing:"Не найдена доступная кнопка «Найти». Проверь, что страница поиска загрузилась.",
    search_button_ambiguous:"Найдено несколько кнопок «Найти». Маления не смогла выбрать нужную.",
    search_navigation_ambiguous:role==="DataLens"?"Не удалось однозначно открыть вкладку «Заказы».":"Не удалось однозначно открыть «Обратный поток».",
    search_results_unconfirmed:"Поиск отправлен, но за 15 секунд не получен однозначный обновлённый результат. Возможны пустой ответ, прежние данные или другая структура таблицы.",
    search_origin_mismatch:"Сервис перенаправил на другой адрес. Проверь вход в рабочей вкладке.",
    unmapped_search_results:"Не удалось распознать результаты поиска на странице сервиса.",
    unverified_search_result_identity:"Результаты не удалось связать с проверяемым заказом.",
    page_timeout:"Страница сервиса не загрузилась вовремя.",
  };
  return reasons[job.failure_reason||""]?`${role}: ${reasons[job.failure_reason!]} Позиция не сдвинута.`:
    `Не удалось проверить партию. Источник: ${role}. Подробная причина не получена — обнови приложение и расширение. Позиция не сдвинута.`;
}
export class InventaRun {
  state:RunState={phase:"idle",processed:0,total:0,source:"",message:"Выбери лист и начни разбор."};
  private epoch=0;
  private controlEpoch=0;
  private inventoryDate:string|undefined;
  private active=false;
  private requesting=false;
  private restarting=false;
  private job:{id:string;end:number;remaining:number}|null=null;
  private queueRequest:Promise<Batch>|null=null;
  private stopping:Promise<void>|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private invoke:Invoke,private changed:(state:RunState)=>void,private delay=2000){}
  private update(patch:Partial<RunState>){this.state={...this.state,...patch};this.changed({...this.state});}
  async start(source:string,inventoryDate?:string){
    if(this.active||this.requesting||this.stopping||this.restarting)return;
    this.active=true;
    if(source!==this.state.source||inventoryDate!==this.inventoryDate)this.update({processed:0,total:0});
    this.inventoryDate=inventoryDate;
    this.update({source,message:"Читаю лист и готовлю очередь; строки «Найден» пропускаются…"});
    await this.next();
  }
  private stopCurrent():Promise<void>{
    if(this.stopping)return this.stopping;
    const job=this.job,pending=this.queueRequest;
    this.active=false;this.job=null;this.epoch++;clearTimeout(this.timer);
    this.update({phase:"pausing",message:"Останавливаю текущий поиск…"});
    const work=(async()=>{
      await this.invoke("cancel_browser_audit",job?{jobId:job.id}:undefined);
      if(pending){
        let batch:Batch|undefined;
        try{batch=await pending;}catch{/* Failed preparation did not create a new job. */}
        if(batch?.job?.job_id && batch.job.job_id!==job?.id)
          await this.invoke("cancel_browser_audit",{jobId:batch.job.job_id});
      }
    })();
    this.stopping=work;
    return work.finally(()=>{if(this.stopping===work)this.stopping=null;});
  }
  async pause(){
    const control=++this.controlEpoch;
    try{
      await this.stopCurrent();
      if(control===this.controlEpoch)this.update({phase:"paused",message:"Пауза. Поиск отменён; позиция сохранена. При продолжении строки «Найден» пропускаются."});
    }catch(error){if(control===this.controlEpoch)this.fail("Не удалось подтвердить остановку: "+String(error));}
  }
  async restart(source:string,inventoryDate?:string){
    if(this.restarting)return;
    this.restarting=true;const control=++this.controlEpoch;
    try{
      await this.stopCurrent();if(control!==this.controlEpoch)return;
      this.update({phase:"waiting",message:"Предыдущая задача отменена. Начинаю заново…"});
      await this.invoke("reset_inventa_order_batch",{spreadsheetUrl:source});
      if(control!==this.controlEpoch)return;
      this.update({processed:0,total:0});
      this.restarting=false;
      await this.start(source,inventoryDate);
    }catch(error){if(control===this.controlEpoch)this.fail(String(error));}
    finally{this.restarting=false;}
  }
  dispose(){this.active=false;this.epoch++;this.controlEpoch++;clearTimeout(this.timer);}
  private fail(message:string){this.active=false;this.job=null;clearTimeout(this.timer);this.update({phase:"error",message});}
  private async next(){
    if(!this.active||this.requesting)return;
    this.requesting=true;const epoch=this.epoch;
    this.update({phase:"waiting"});
    const request=(async()=>this.invoke<Batch>("check_inventa_order_batch",{spreadsheetUrl:this.state.source,inventoryDate:this.inventoryDate||null}))();
    this.queueRequest=request;
    try{
      const batch=await request;
      if(epoch!==this.epoch){
        if(batch.job?.job_id)await this.invoke("cancel_browser_audit",{jobId:batch.job.job_id});
        return;
      }
      if(!batch.job?.job_id||batch.queued_orders<1)throw Error("Некорректный ответ очереди");
      if(this.state.processed>batch.batch_start && this.state.source){
        await this.pause();
        if(this.state.phase==="paused")this.update({message:"Список строк изменился. Нажми «Начать заново», чтобы проверить новую позицию."});
        return;
      }
      this.job={id:batch.job.job_id,end:batch.batch_end??batch.batch_start+batch.queued_orders,remaining:batch.remaining_orders};
      this.update({processed:batch.batch_start,total:batch.eligible_orders,phase:"waiting",
        message:"Ожидаю Browser Bridge. Уже найденные строки не включаются в поиск."});
      this.schedule();
    }catch(error){
      if(epoch!==this.epoch)return;
      if(String(error).includes("inventa_batch_complete")){
        this.active=false;this.update({phase:"completed",processed:this.state.total,message:"Заказов для проверки не осталось. Строки со статусом «Найден» пропущены."});
      }else this.fail(String(error));
    }finally{if(this.queueRequest===request)this.queueRequest=null;this.requesting=false;}
  }
  private schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.poll(),this.delay);}
  private async poll(){
    if(!this.job)return;
    const epoch=this.epoch;
    try{
      const data=await this.invoke<{browser_audit_job:Job|null}>("get_dashboard");
      if(epoch!==this.epoch)return;
      const current=data.browser_audit_job;
      if(!current||current.job_id!==this.job?.id){this.fail("Очередь изменилась. Нажми «Продолжить», чтобы сверить сохранённую позицию.");return;}
      if(current.status==="completed"){
        const completed=this.job!;this.job=null;
        this.update({processed:completed.end});
        if(!completed.remaining){this.active=false;this.update({phase:"completed",message:"Разбор листа завершён. По DataLens записаны «Найден» и зелёная заливка; по Asgard — проверенные статусы и комментарии."});return;}
        if(this.active)await this.next();
      }else if(["failed","expired"].includes(current.status)){
        this.fail(current.failure_reason==="sources_not_configured"?"Расширение получило задачу, но источники не настроены. В Browser Bridge выбери рабочие вкладки и сохрани их.":current.failure_reason==="browser_permission_missing"?"Браузер не разрешил чтение источников. В Browser Bridge нажми «Сохранить и разрешить чтение».":current.failure_reason==="agent_restarted"?"Предыдущая проверка прервана перезапуском. Можно начать разбор снова.":current.status==="expired"?"Browser Bridge не ответил. Проверь расширение и разрешения, затем продолжи.":auditFailureMessage(current));
      }else{
        this.update({phase:current.status==="running"?"running":"waiting",message:current.status==="running"?`Расширение выполняет этап: ${{inventory:"чтение инвентаризации",datalens:"поиск в DataLens",asgard:"проверка карточек Asgard"}[current.current_role||""]||"подготовка"}.`:"Расширение ещё не забрало задачу. Поиск на сайтах не начался."});
        this.schedule();
      }
    }catch(error){if(epoch===this.epoch)this.fail("Связь с агентом прервалась: "+String(error));}
  }
}
