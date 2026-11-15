/* Background task, bounded to three explicitly permitted resources. */
importScripts("automation.js");
const HOST = "com.malenia.browser";
let running = false;

function nativeSession() {
  // A native messaging port keeps the MV3 worker alive while the job is active.
  const port = chrome.runtime.connectNative(HOST);
  let pending = null;
  let closed = false;
  port.onMessage.addListener(response => {
    if (!pending) return;
    const active = pending;
    pending = null;
    clearTimeout(active.timer);
    if (!response || response.request_id !== active.id) active.reject(new Error("host_protocol"));
    else active.resolve(response);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    if (pending) {
      const active = pending;
      pending = null;
      clearTimeout(active.timer);
      active.reject(new Error("host_disconnected"));
    }
  });
  return {
    send(message) {
      if (closed || pending) return Promise.reject(new Error("host_not_ready"));
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          if (pending && pending.id === id) {
            pending = null;
            closed = true;
            port.disconnect();
            reject(new Error("host_timeout"));
          }
        }, ['mark_inventa_found','mark_inventa_asgard'].includes(message.type)?120000:5000);
        pending = {id, timer, resolve, reject};
        try { port.postMessage({...message, request_id:id}); }
        catch {
          clearTimeout(timer);
          pending = null;
          closed = true;
          reject(new Error("host_disconnected"));
        }
      });
    },
    close() {
      closed = true;
      if (pending) {
        const active = pending;
        pending = null;
        clearTimeout(active.timer);
        active.reject(new Error("host_closed"));
      }
      port.disconnect();
    }
  };
}

async function progress(snapshot) {
  // Never store page text, cargo codes, login data, or raw browser errors.
  const version=chrome.runtime.getManifest?.()?.version;
  await chrome.storage.session.set({maleniaAudit:{...snapshot,
    ...(typeof version==='string' && /^\d+\.\d+\.\d+$/.test(version)?{bridge_version:version}:{})}});
}
let targetWrites = Promise.resolve();
async function configureActiveSource(message) {
  if (!["inventory","datalens","asgard"].includes(message.role)) throw new Error("invalid_role");
  const validated=MaleniaAutomation.normalizeTargets(Object.fromEntries(
    ["inventory","datalens","asgard"].map(role=>[role,message.url])));
  const url=validated[message.role];
  if(!await chrome.permissions.contains({origins:[new URL(url).origin+"/*"]}))throw new Error("permissions_missing");
  const stored=await chrome.storage.local.get("maleniaTargets");
  const targets={};
  for(const role of ["inventory","datalens","asgard"]){
    const saved=stored?.maleniaTargets?.[role];
    if(saved){try{targets[role]=MaleniaAutomation.normalizeTargets(Object.fromEntries(
      ["inventory","datalens","asgard"].map(key=>[key,saved])))[role];}catch{/* omit invalid old settings */}}
  }
  targets[message.role]=url;
  await chrome.storage.local.set({maleniaTargets:targets,maleniaExactGetSearch:true});
  return targets;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if(message?.type === "configure_active_source") {
    const operation=targetWrites.then(()=>configureActiveSource(message));
    targetWrites=operation.catch(()=>{});
    operation.then(targets=>{respond({ok:true,targets});void pollDesktopAudit();},()=>respond({ok:false,error:"source_not_saved"}));
    return true;
  }
  if (message?.type === "poll_desktop_audit") { void pollDesktopAudit(); respond({ok:true}); return false; }
  if (!message || message.type !== "start_readonly_audit") return false;
  if (running) { respond({ok:false,error:"already_running"});return false; }
  let targets;
  try { targets=MaleniaAutomation.normalizeTargets(message.targets); }
  catch { respond({ok:false,error:"invalid_targets"});return false; }
  running=true;
  respond({ok:true});
  (async () => {
    let session;
    try {
      const allowed=await chrome.permissions.contains({origins:MaleniaAutomation.origins(targets)});
      if (!allowed) throw new Error("permissions_missing");
      await progress({phase:"starting",results:[]});
      session=nativeSession();
      const hello=await session.send({type:"hello"});
      if (!hello.ok || hello.host!==HOST ||
          !Array.isArray(hello.capabilities) ||
          !hello.capabilities.includes("inspect_active_page")) {
        throw new Error("unsupported_host");
      }
      await MaleniaAutomation.run(chrome,targets,message=>session.send(message),progress,
        {exactGetSearch:message.exactGetSearch === true});
    } catch {
      await progress({phase:"needs_attention",results:[],error:"setup_or_connection"});
    } finally {
      session?.close();
      running=false;
    }
  })();
  return false;
});


// Desktop-triggered jobs use a separate one-shot request queue. The extension
// wakes periodically, never accepts arbitrary URLs or page actions from desktop.
const DESKTOP_AUDIT_ALARM = "malenia-desktop-audit-check";
async function pollDesktopAudit() {
  if (running) return;
  // Reserve the worker before the first await: alarms and popup requests can
  // arrive while permissions or the native host handshake are still pending.
  running = true;
  let session;
  try {
    const stored = await chrome.storage.local.get(["maleniaTargets", "maleniaExactGetSearch"]);
    session = nativeSession();
    const hello = await session.send({type:"hello"});
    if (!hello?.ok || hello.host !== HOST ||
        !hello.capabilities?.includes("claim_browser_audit") ||
        !hello.capabilities?.includes("finish_browser_audit") ||
        !hello.capabilities?.includes("update_browser_audit_progress") ||
        !hello.capabilities?.includes("reconcile_site_tables")) return;
    const claimed = await session.send({type:"claim_browser_audit"});
    const jobId = claimed?.job?.job_id;
    if (!claimed?.ok || !claimed.job || typeof jobId !== "string") return;
    let succeeded = false;
    let failureReason = "execution_failed";
    try {
      let targets;
      try { targets = MaleniaAutomation.normalizeTargets(stored?.maleniaTargets); }
      catch { failureReason="sources_not_configured"; throw new Error(failureReason); }
      if (!await chrome.permissions.contains({origins:MaleniaAutomation.origins(targets)})) {
        failureReason="browser_permission_missing"; throw new Error(failureReason);
      }
      await progress({phase:"starting",results:[]});
      const report = async snapshot => {
        await progress(snapshot);
        const results = snapshot.results || [];
        const failures = results.filter(item => item.status === "needs_attention");
        if (failures.length && hello.capabilities.includes("detailed_audit_failures")) {
          failureReason = MaleniaAutomation.reasonCode(new Error(failures[failures.length-1].reason));
        }
        const failedRole = failures.length ? failures[failures.length-1].role : null;
        const currentRole = ["inventory","datalens","asgard"].includes(snapshot.role) ?
          snapshot.role : null;
        const response = await session.send({
          type:"update_browser_audit_progress",job_id:jobId,
          current_role:currentRole,completed_sources:results.length,
          attention_sources:failures.length,failed_role:failedRole
        });
        if (!response?.ok || response.type !== "browser_audit_progress_updated") {
          throw new Error("audit_progress_unavailable");
        }
      };
      if(claimed.job.writeback_required && !hello.capabilities.includes('mark_inventa_found')){
        failureReason='inventa_writeback_required';throw new Error(failureReason);
      }
      if(claimed.job.asgard_writeback_required && !hello.capabilities.includes('mark_inventa_asgard')){
        failureReason='inventa_writeback_required';throw new Error(failureReason);
      }
      const result = await MaleniaAutomation.run(chrome,targets,
        message=>session.send(message),report,
        {exactGetSearch:claimed.job.inventory ? true : stored.maleniaExactGetSearch !== false,
         ...(claimed.job.inventory ? {seedInventory:claimed.job.inventory} : {}),
         ...(claimed.job.writeback_required?{writebackJobId:jobId}:{}),
         asgardWriteback:claimed.job.asgard_writeback_required===true});
      succeeded = result.phase === "reconciled" &&
        (!claimed.job.writeback_required || result.writeback?.verified===true);
      if(claimed.job.writeback_required && result.phase==='reconciled' && !succeeded)
        failureReason='inventa_writeback_required';
    } catch {
      await progress({phase:"needs_attention",results:[],error:"setup_or_connection"});
    } finally {
      // Never retry an unacknowledged claim automatically. The store expires it.
      try { await session.send({type:"finish_browser_audit",job_id:jobId,succeeded, ...(hello.capabilities.includes("audit_failure_reasons")?{failure_reason:succeeded?null:failureReason}:{})}); }
      catch { /* Extension may have disconnected. */ }
    }
  } catch { /* Host unavailable, no permissions, or extension restarting. */ }
  finally {
    try { session?.close(); }
    finally { running = false; }
  }
}
function enableDesktopAuditPolling() {
  chrome.alarms.create(DESKTOP_AUDIT_ALARM,{periodInMinutes:1});
}
chrome.runtime.onInstalled.addListener(enableDesktopAuditPolling);
chrome.runtime.onStartup.addListener(enableDesktopAuditPolling);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === DESKTOP_AUDIT_ALARM) void pollDesktopAudit();
});
enableDesktopAuditPolling();
