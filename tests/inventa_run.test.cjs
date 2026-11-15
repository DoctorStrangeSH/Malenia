const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createRequire}=require('node:module');
const ts=createRequire(path.resolve(__dirname,'../desktop/package.json'))('typescript');
const source=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../desktop/src/inventaRun.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
  const timers=new Map();let seq=0,offset=0,requests=0,status='pending',latest;
  const exports={};vm.runInNewContext(source,{exports,setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)});
  const states=[],calls=[];
  const invoke=async (command,args)=>{
    calls.push({command,args});
    if(command==='cancel_browser_audit'){status='failed';return {cancelled:true};}
    if(command==='reset_inventa_order_batch'){offset=0;latest=null;return {reset:true};}
    if(command==='get_dashboard')return {browser_audit_job:latest?{...latest,status}:null};
    requests++;const start=offset;latest={job_id:'job-'+requests,status:'pending'};status='pending';
    return {job:latest,batch_start:start,queued_orders:Math.min(20,45-start),eligible_orders:45,remaining_orders:Math.max(0,45-start-20)};
  };
  const runner=new exports.InventaRun(invoke,state=>states.push(state));
  return {runner,states,calls,get requests(){return requests;},
    setStatus(value){status=value;if(value==='completed')offset=Math.min(45,offset+20);},
    replaceJob(){latest={job_id:'some-other-job'};},
    async tick(){const [id,fn]=timers.entries().next().value||[];assert.ok(fn,'poll is scheduled');timers.delete(id);fn();await flush();},
    get timerCount(){return timers.size;}};
}
test('one start automatically checks the entire sheet and counts only acknowledged completions',async()=>{
  const h=harness();await h.runner.start('SHEET');
  assert.equal(h.requests,1);assert.equal(h.runner.state.processed,0);
  h.setStatus('running');await h.tick();assert.equal(h.requests,1);
  for(const done of [20,40,45]){
    h.setStatus('completed');await h.tick();assert.equal(h.runner.state.processed,done);
  }
  assert.equal(h.requests,3);assert.equal(h.runner.state.phase,'completed');assert.equal(h.timerCount,0);
});
test('pause cancels the current job and resume queues only after stopping',async()=>{
  const h=harness();await h.runner.start('SHEET');h.runner.pause();
  assert.equal(h.runner.state.phase,'pausing');
  await flush();assert.equal(h.requests,1);assert.equal(h.runner.state.phase,'paused');assert.equal(h.timerCount,0);
  assert.ok(h.calls.some(c=>c.command==='cancel_browser_audit'&&c.args.jobId==='job-1'));
  await h.runner.start('SHEET');assert.equal(h.requests,2);assert.equal(h.runner.state.processed,0);
  h.runner.dispose();
});
test('failed or replaced jobs stop continuation without counting the batch as processed',async()=>{
  for(const failure of ['failed','expired','replaced']){
    const h=harness();await h.runner.start('SHEET');
    if(failure==='replaced')h.replaceJob();else h.setStatus(failure);
    await h.tick();assert.equal(h.requests,1);assert.equal(h.runner.state.phase,'error');
    assert.equal(h.runner.state.processed,0);assert.equal(h.timerCount,0);
  }
});
test('duplicate clicks and switching sheets cannot enqueue concurrent jobs',async()=>{
  const h=harness();await h.runner.start('SHEET');await h.runner.start('SHEET');
  h.runner.pause();await h.runner.start('OTHER');assert.equal(h.requests,1);assert.equal(h.runner.state.source,'SHEET');
  h.runner.dispose();assert.equal(h.timerCount,0);
});

 test('chosen inventory date follows every batch and explicit restart resets saved position',async()=>{
  const h=harness();await h.runner.start('SHEET','2026-09-26');
  h.setStatus('completed');await h.tick();
  const requests=h.calls.filter(c=>c.command==='check_inventa_order_batch');
  assert.equal(requests.length,2);
  assert.ok(requests.every(c=>c.args.inventoryDate==='2026-09-26'));
  await h.runner.pause();
  await h.runner.restart('SHEET','2026-08-29');
  assert.equal(h.runner.state.processed,0);
  assert.ok(h.calls.some(c=>c.command==='reset_inventa_order_batch'));
  assert.equal(h.calls.at(-1).args.inventoryDate,'2026-08-29');
  h.runner.dispose();
});

test('restart cancels an active job before resetting and queues a fresh batch',async()=>{
 const h=harness();await h.runner.start('SHEET');
 await h.runner.restart('SHEET');
 assert.equal(h.requests,2);
 const commands=h.calls.map(c=>c.command);
 assert.deepEqual(commands.slice(-3),['cancel_browser_audit','reset_inventa_order_batch','check_inventa_order_batch']);
 assert.equal(h.runner.state.processed,0);h.runner.dispose();
});

 test('localized Asgard failure explains the next action without exposing raw errors',()=>{
   const exports={};vm.runInNewContext(source,{exports});
   const message=exports.auditFailureMessage({failed_role:'asgard',failure_reason:'search_filters_not_empty'});
   assert.match(message,/Asgard/);assert.match(message,/Очисти/);assert.match(message,/Позиция не сдвинута/);
   const unknown=exports.auditFailureMessage({failed_role:'asgard',failure_reason:'https://private.example/SECRET'});
   assert.doesNotMatch(unknown,/SECRET|private/);assert.match(unknown,/Подробная причина не получена/);
 });


test('DataLens navigation errors name Orders and Asgard errors name reverse flow',()=>{
 const exports={};vm.runInNewContext(source,{exports});
 const dl=exports.auditFailureMessage({failed_role:'datalens',failure_reason:'search_navigation_ambiguous'});
 assert.match(dl,/Заказы/);assert.doesNotMatch(dl,/Обратный поток/);
 const asgard=exports.auditFailureMessage({failed_role:'asgard',failure_reason:'search_navigation_ambiguous'});
 assert.match(asgard,/Обратный поток/);
});

function controlledRunner(invoke){
 const exports={};vm.runInNewContext(source,{exports,setTimeout:()=>1,clearTimeout(){}});
 return new exports.InventaRun(invoke,()=>{});
}
const batch=(id='old',extra={})=>({job:{job_id:id},batch_start:0,queued_orders:2,eligible_orders:5,batch_end:5,remaining_orders:0,...extra});
test('pause during queue preparation cancels the late job by ID and never starts polling it',async()=>{
 let release;const calls=[];
 const r=controlledRunner(async(command,args)=>{calls.push({command,args});if(command==='check_inventa_order_batch')return new Promise(resolve=>release=resolve);return {};});
 const started=r.start('SHEET');await flush();const paused=r.pause();await flush();
 release(batch());await Promise.all([started,paused]);
 assert.equal(r.state.phase,'paused');assert.ok(calls.some(c=>c.command==='cancel_browser_audit'&&c.args?.jobId==='old'));
});
test('restart waits for stale preparation to be cancelled before queueing a new generation',async()=>{
 let release,requests=0;const calls=[];
 const r=controlledRunner(async(command,args)=>{calls.push({command,args});if(command==='check_inventa_order_batch')return ++requests===1?new Promise(resolve=>release=resolve):batch('new');return {};});
 const started=r.start('SHEET');await flush();const restarted=r.restart('SHEET');await flush();
 assert.equal(requests,1);release(batch());await Promise.all([started,restarted]);
 assert.equal(requests,2);assert.ok(!calls.some(c=>c.command==='cancel_browser_audit'&&c.args?.jobId==='new'));
 assert.ok(calls.findIndex(c=>c.args?.jobId==='old')<calls.findIndex(c=>c.command==='reset_inventa_order_batch'));
 r.dispose();
});
test('a late completed poll cannot overwrite pause or start another batch',async()=>{
 let release;
 const r=controlledRunner(async command=>command==='check_inventa_order_batch'?batch():command==='get_dashboard'?new Promise(resolve=>release=resolve):{});
 await r.start('SHEET');const poll=r.poll();await flush();await r.pause();
 release({browser_audit_job:{job_id:'old',status:'completed'}});await poll;
 assert.equal(r.state.phase,'paused');assert.equal(r.state.processed,0);
});
test('pause while restart is resetting prevents its new search from starting',async()=>{
 let release,requests=0;
 const r=controlledRunner(async command=>command==='check_inventa_order_batch'?(requests++,batch()):command==='reset_inventa_order_batch'?new Promise(resolve=>release=resolve):{});
 await r.start('SHEET');const restarted=r.restart('SHEET');await flush();await r.pause();release({});await restarted;
 assert.equal(requests,1);assert.equal(r.state.phase,'paused');
});
test('sparse source positions count already-found gaps without dropping pending orders',async()=>{
 const r=controlledRunner(async command=>command==='check_inventa_order_batch'?batch():{browser_audit_job:{job_id:'old',status:'completed'}});
 await r.start('SHEET');await r.poll();assert.equal(r.state.processed,5);assert.equal(r.state.phase,'completed');
});
test('a synchronous queue connection failure becomes a recoverable error state',async()=>{
 const r=controlledRunner(()=>{throw Error('local agent disconnected');});
 await r.start('SHEET');assert.equal(r.state.phase,'error');assert.match(r.state.message,/disconnected/);
});
