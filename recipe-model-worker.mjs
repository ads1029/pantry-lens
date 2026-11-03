import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {RecipeError, MAX_RECIPE_BYTES} from './recipe-queue.mjs';
import {recipePolicy, restrictedRecipeConfig, elapsed} from './recipe-telemetry.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// Owned by the foreground web service. Idle connections never start model turns.
export function createRecipeModelWorker({command = 'codex', spawnProcess = spawn} = {}) {
  let child, directory, starting, stopped = false, sequence = 0, active, closePromise, busy = false;
  const pending = new Map();
  function call(method, params = {}, timeoutMs = 15000) {
    if (!child || child.killed) return Promise.reject(new RecipeError('模型连接不可用，请重试。', 503));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new RecipeError('模型连接响应超时，请重试。', 504)); }, timeoutMs);
      pending.set(id, {resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); }});
      child.stdin.write(JSON.stringify({id, method, params}) + '\n', error => { if (error) { const item = pending.get(id); pending.delete(id); item?.reject(new RecipeError('模型连接已中断。', 503)); } });
    });
  }
  function receive(message) {
    if (message.id !== undefined && !message.method) {
      const item = pending.get(message.id); pending.delete(message.id);
      if (message.error) item?.reject(new RecipeError('模型连接配置或请求被拒绝，请检查本机 Codex。', 502));
      else item?.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      child?.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'Interactive and tool requests are disabled'}}) + '\n');
      active?.reject(new RecipeError('生成器请求了未授权工具，已停止本次推荐。', 502));
      return;
    }
    const job = active, p = message.params;
    if (!job || !p || p.threadId !== job.threadId) return;
    const t = job.metrics.timingsMs;
    t.firstEvent ??= elapsed(job.start);
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') {
      t.firstText ??= elapsed(job.start);
      job.text += p.delta;
      if (Buffer.byteLength(job.text) > MAX_RECIPE_BYTES) job.reject(new RecipeError('模型输出超过大小限制。', 502));
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') job.text = p.item.text;
    if (message.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage?.last ?? {};
      job.metrics.usage = {inputTokens: count(u.inputTokens), cachedInputTokens: count(u.cachedInputTokens), outputTokens: count(u.outputTokens), reasoningTokens: count(u.reasoningOutputTokens)};
    }
    if (message.method === 'model/rerouted' && typeof p.toModel === 'string' && /^[\w.-]{1,100}$/.test(p.toModel)) job.metrics.reportedModel = p.toModel;
    if (message.method === 'turn/completed') {
      t.modelRequest = elapsed(job.turnStart);
      if (p.turn?.status !== 'completed') job.reject(new RecipeError('模型本次推荐未完成，请重试。', 502));
      else job.resolve();
    }
  }
  async function terminate() {
    if (!child) { await closePromise; return; }
    const owned = child;
    try { if (process.platform !== 'win32' && owned.pid) process.kill(-owned.pid, 'SIGTERM'); else owned.kill('SIGTERM'); } catch {}
    const hard = setTimeout(() => { try { if (process.platform !== 'win32' && owned.pid) process.kill(-owned.pid, 'SIGKILL'); else owned.kill('SIGKILL'); } catch {} }, 2000);
    await closePromise; clearTimeout(hard);
  }
  async function start() {
    if (stopped) throw new RecipeError('模型连接已关闭。', 503);
    if (starting) return starting;
    starting = (async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'pantry-model-connection-'));
      if (stopped) { await rm(directory, {recursive: true, force: true}); directory = null; throw new RecipeError('模型连接已关闭。', 503); }
      const config = {...restrictedRecipeConfig(), model_provider: 'openai', 'apps._default.enabled': false};
      const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];
      const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
      child = spawnProcess(command, ['app-server', '--listen', 'stdio://', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])], {cwd: directory, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
      let buffer = ''; const decoder = new StringDecoder('utf8');
      child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > 1024 * 1024) { active?.reject(new RecipeError('模型连接输出异常。', 502)); void terminate(); return; }
        let i;
        while ((i = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { receive(JSON.parse(line)); } catch { /* Ignore non-protocol lines, never log them. */ } }
      });
      closePromise = new Promise(resolve => child.once('close', async () => {
        const error = new RecipeError('模型连接已中断，请重试。', 503);
        for (const item of pending.values()) item.reject(error); pending.clear(); active?.reject(error);
        child = null; starting = null;
        const oldDirectory = directory; directory = null;
        if (oldDirectory) await rm(oldDirectory, {recursive: true, force: true});
        resolve();
      }));
      child.on('error', () => { for (const item of pending.values()) item.reject(new RecipeError('无法启动 Codex 模型连接。', 503)); pending.clear(); });
      await call('initialize', {clientInfo: {name: 'pantry_lens', title: 'Pantry Lens', version: '0.5.0'}, capabilities: {experimentalApi: true}});
      child.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
      await call('model/list', {limit: 50, includeHidden: false}); // Metadata only; no model turn.
      return true;
    })();
    try { return await starting; } catch (error) { await terminate(); starting = null; throw error; }
  }
  async function generate(request, {protocol, signal, onMetrics = () => {}, policy = recipePolicy, timeoutMs = 180000} = {}) {
    if (busy) throw new RecipeError('模型连接正在处理其他推荐。', 429);
    busy = true;
    const startTime = performance.now();
    const metrics = {configuredModel: policy.model, reportedModel: null, reasoningEffort: policy.reasoningEffort, promptVersion: 'catalog-selector-v1', generationMode: 'catalog', transport: 'app-server', timingsMs: {}, usage: {inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null}};
    let threadId, timeout, abort;
    try {
      await start();
      if (signal?.aborted) throw new RecipeError('推荐已中断。', 503);
      // Read only MCP server identifiers, discard all configuration values.
      // Every inherited MCP connection is explicitly disabled for this task.
      const effective = await call('config/read', {includeLayers: false, cwd: directory});
      if (!effective?.config || typeof effective.config !== 'object') throw new RecipeError('无法确认模型执行配置，请重试。', 503);
      const mcp = Object.fromEntries(Object.keys(effective?.config?.mcp_servers ?? {}).map(name => [name, {enabled: false}]));
      const thread = await call('thread/start', {model: policy.model, modelProvider: 'openai', cwd: directory, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, baseInstructions: protocol.instructions, config: {...restrictedRecipeConfig(policy), mcp_servers: mcp}, runtimeWorkspaceRoots: [], environments: [], dynamicTools: [], selectedCapabilityRoots: []});
      threadId = thread.thread.id; metrics.reportedModel = typeof thread.model === 'string' && /^[\w.-]{1,100}$/.test(thread.model) ? thread.model : null; metrics.timingsMs.threadStart = elapsed(startTime);
      if (signal?.aborted) throw new RecipeError('推荐已中断。', 503);
      const done = new Promise((resolve, reject) => {
        active = {threadId, metrics, start: startTime, turnStart: performance.now(), text: '', resolve, reject};
        abort = () => { reject(new RecipeError('推荐已中断。', 503)); void terminate(); };
        signal?.addEventListener('abort', abort, {once: true});
        timeout = setTimeout(() => { reject(new RecipeError('推荐超过 3 分钟，请重试。', 504)); void terminate(); }, timeoutMs);
      });
      const turn = call('turn/start', {threadId, model: policy.model, effort: policy.reasoningEffort, summary: 'none', environments: [], runtimeWorkspaceRoots: [], input: [{type: 'text', text: protocol.input(request)}], outputSchema: protocol.schema}, timeoutMs);
      await Promise.all([turn, done]);
      const text = active.text, parseStart = performance.now();
      if (Buffer.byteLength(text) > MAX_RECIPE_BYTES) throw new RecipeError('模型输出超过大小限制。', 502);
      const output = protocol.decode(JSON.parse(text), request);
      metrics.timingsMs.parse = elapsed(parseStart); metrics.resultBytes = Buffer.byteLength(text);
      return {...output, schemaVersion: 1, requestId: request.requestId, source: 'codex', generatedAt: new Date().toISOString(), generation: {mode: 'catalog', libraryVersion: protocol.version}};
    } catch (error) { await terminate(); throw error; }
    finally {
      clearTimeout(timeout); if (abort) signal?.removeEventListener('abort', abort);
      active = null;
      if (threadId && child) await call('thread/unsubscribe', {threadId}).catch(() => {});
      metrics.timingsMs.generator = elapsed(startTime); busy = false; onMetrics(metrics);
    }
  }
  return {start, generate, async close() { stopped = true; await terminate(); if (starting) await starting.catch(() => {}); }};
}
