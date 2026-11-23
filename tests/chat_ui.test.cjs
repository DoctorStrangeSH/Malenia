const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const localRequire = Module.createRequire(path.resolve(__dirname, '../desktop/package.json'));
const ts = localRequire('typescript');

// Render Chat with tiny fake hooks; child components are not rendered.
function harness(invoke, props = {}) {
  const slots = []; let cursor = 0;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = {current: initial}; return slots[i]; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, n) => v !== slots[i][n])) { slots[i] = deps; fn(); } },
  };
  const icons = new Proxy({}, {get: () => () => null});
  const load = (file, overrides) => {
    const mod = new Module(file, module);
    mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
    const original = mod.require.bind(mod);
    mod.require = name => name in overrides ? overrides[name] : original(name);
    mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022}}).outputText, file);
    return mod.exports;
  };
  const src = path.resolve(__dirname, '../desktop/src');
  const api = load(path.join(src, 'api.ts'), {'@tauri-apps/api/core': {invoke}});
  const chat = load(path.join(src, 'Chat.tsx'), {react: hooks, '@tauri-apps/api/core': {invoke}, 'lucide-react': icons, './api': api, './Markdown': {Markdown: () => null}, './Logo': {Logo: () => null}});
  const events = {conversation: [], ui: []};
  const base = {connected: true, conversationId: null, onConversation: id => events.conversation.push(id), onChanged() {}, instruction: null, onClearInstruction() {}, onOpenSettings() {}, onOpenTools() {}, onUiAction: action => events.ui.push(action)};
  const render = () => { cursor = 0; return chat.Chat({...base, ...props}); };
  const all = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(item => all(item, predicate));
    return [...(predicate(tree) ? [tree] : []), ...all(tree.props?.children, predicate)];
  };
  const find = (type, predicate = () => true) => all(render(), e => e.type === type && predicate(e.props));
  return {render, find, events};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const providers = {mode: 'auto', learning: true, auto_web: true, local_model: null, order: ['gemini'], providers: [{id: 'gemini', enabled: true}]};
const reply = (id = 'c1') => ({conversation_id: id,
  user_message: {id: 'u', role: 'user', content: 'q', meta: {}, feedback: 0},
  message: {id: 'a', role: 'assistant', content: 'ответ', meta: {}, feedback: 0, provider: 'gemini', model: 'm'}});

test('sending goes through the assistant route with web on and private off by default', async () => {
  const calls = [];
  const h = harness(async (command, args) => {
    calls.push({command, args});
    if (args?.path === '/v1/ai/providers') return providers;
    if (args?.path === '/v1/assistant/chat') return reply();
    throw Error(args?.path);
  });
  h.render(); await tick();
  h.find('textarea', p => p['aria-label'] === 'Сообщение')[0].props.onChange({target: {value: 'Составь план'}});
  h.find('button', p => p['aria-label'] === 'Отправить')[0].props.onClick(); await tick();
  const chat = calls.find(c => c.args?.path === '/v1/assistant/chat');
  assert.equal(chat.command, 'agent_api');
  assert.equal(chat.args.method, 'POST');
  assert.deepEqual({message: chat.args.body.message, private: chat.args.body.private, use_web: chat.args.body.use_web}, {message: 'Составь план', private: false, use_web: true});
  assert.deepEqual(h.events.conversation, ['c1']);
});

test('private mode is sent explicitly and a failed request restores the draft', async () => {
  const bodies = [];
  const h = harness(async (command, args) => {
    if (args?.path === '/v1/ai/providers') return providers;
    if (args?.path === '/v1/assistant/chat') { bodies.push(args.body); throw 'Бесплатный лимит модели исчерпан'; }
    throw Error(args?.path);
  });
  h.render(); await tick();
  h.find('button', p => p['aria-pressed'] === false && /Только локальная/.test(p.title))[0].props.onClick();
  h.find('textarea', p => p['aria-label'] === 'Сообщение')[0].props.onChange({target: {value: 'Секретный вопрос'}});
  h.find('button', p => p['aria-label'] === 'Отправить')[0].props.onClick(); await tick();
  assert.equal(bodies[0].private, true);
  assert.equal(h.find('textarea', p => p['aria-label'] === 'Сообщение')[0].props.value, 'Секретный вопрос');
  assert.equal(h.find('div', p => p.role === 'alert').length, 1);
});

test('empty input never calls the model', async () => {
  const calls = [];
  const h = harness(async (command, args) => { calls.push(args?.path); return providers; });
  h.render(); await tick();
  h.find('button', p => p['aria-label'] === 'Отправить')[0].props.onClick(); await tick();
  assert.ok(!calls.includes('/v1/assistant/chat'));
});

test('an app action chosen by Malenia is handed to the app and attachments are sent', async () => {
  const bodies = [];
  const h = harness(async (command, args) => {
    if (args?.path === '/v1/ai/providers') return providers;
    if (args?.path === '/v1/assistant/chat') {
      bodies.push(args.body);
      const r = reply();
      r.message.meta = {actions: [{id: 'x', tool: 'open_inventory', status: 'ui', summary: 'Запустить проверку инвентаризации', arguments: {start: true}, result: {ui: 'open_inventory', start: true}}]};
      return r;
    }
    throw Error(args?.path);
  });
  h.render(); await tick();
  h.find('textarea', p => p['aria-label'] === 'Сообщение')[0].props.onChange({target: {value: 'Проверь инвентаризацию'}});
  h.find('button', p => p['aria-label'] === 'Отправить')[0].props.onClick(); await tick();
  assert.deepEqual(bodies[0].attachments, []);
  assert.equal(h.events.ui.length, 1);
  assert.equal(h.events.ui[0].result.start, true);
});
