import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRecipeQueue, RecipeError} from '../recipe-queue.mjs';
import {createRecipeAutomation, generateWithCodex, expandRecipeOutput, ingredientCatalog} from '../recipe-generator.mjs';
import {createPantryServer} from '../server.mjs';
import {eventTelemetry} from '../recipe-telemetry.mjs';
import {recipeLibrary, catalogCandidates, catalogProtocol, instantiateRecipe} from '../recipe-catalog.mjs';
import {createRecipeModelWorker} from '../recipe-model-worker.mjs';

const input = {ingredients: '合成食材', servings: 2, maxMinutes: 30};
const result = request => ({schemaVersion: 1, requestId: request.requestId, source: 'codex', generatedAt: new Date().toISOString(), status: 'completed', recipes: [1, 2, 3].map(i => ({title: `合成测试${i}`, reason: '只作测试', minutes: 10, servings: 2, ingredients: [{name: '合成食材', amount: '适量', availability: 'provided'}], steps: ['测试步骤'], tips: '测试提示'}))});
async function setup(t, generate) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pantry-auto-test-'));
  const queue = createRecipeQueue(directory), automation = createRecipeAutomation({queue, generate});
  t.after(async () => { await automation.close(); await rm(directory, {recursive: true, force: true}); });
  return {queue, automation, directory};
}

test('自动 HTTP 请求立即返回202；限制并发、运行中重试幂等，完成后只读结果', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const {queue, automation} = await setup(t, async request => { calls++; await gate; return result(request); });
  const server = createPantryServer({recipes: queue, automation});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/recipes/requests`;
  const headers = {'Content-Type': 'application/json', 'X-Pantry-Local': '1'};
  const submit = () => fetch(base, {method: 'POST', headers, body: JSON.stringify(input)});
  const response = await submit(); assert.equal(response.status, 202);
  const body = await response.json(), id = body.request.requestId;
  assert.equal(body.job.status, 'running');
  assert.equal((await submit()).status, 429);
  assert.equal((await fetch(`${base}/${id}/retry`, {method: 'POST', headers})).status, 202);
  assert.equal(calls, 1);
  assert.equal((await fetch(`${base}/${id}/retry`, {method: 'POST', headers: {...headers, Origin: 'https://evil.example'}})).status, 403);
  const display = value => fetch(`${base}/${id}/displayed`, {method: 'POST', headers, body: JSON.stringify(value)});
  const timing = {attemptId: body.metrics.attemptId, totalMs: 1500, acceptedMs: 20, afterAcceptedMs: 1480, renderMs: 5};
  assert.equal((await display(timing)).status, 409);
  release(); await automation.idle();
  assert.equal((await (await fetch(`${base}/${id}`, {headers})).json()).result.recipes.length, 3);
  assert.equal((await automation.retry(id)).status, 'ready');
  assert.equal(calls, 1);
  assert.equal((await display({...timing, attemptId: 'old'})).status, 409);
  assert.equal((await display({...timing, totalMs: -1})).status, 400);
  const measured = await (await display(timing)).json();
  assert.equal(measured.metrics.browser.totalMs, 1500);
  assert.ok(measured.metrics.timingsMs.backend >= 0);
  // A later reload or duplicate receipt cannot turn 1.5s into a fake 20ms success.
  await display({...timing, totalMs: 20, afterAcceptedMs: 0});
  assert.equal((await queue.metrics(id)).browser.totalMs, 1500);
});

test('JSONL 分段/UTF-8 事件只保存数值与模型信息，缺失推理用量保留未知', () => {
  const metrics = {timingsMs: {}, usage: null};
  const events = eventTelemetry(performance.now(), metrics);
  const data = Buffer.from(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: '私人文字不应进入性能记录'}}) + '\n' + JSON.stringify({type: 'turn.completed', model: 'test-model', usage: {input_tokens: 10, cached_input_tokens: 3, output_tokens: 5}}));
  for (let i = 0; i < data.length; i += 3) events.push(data.subarray(i, i + 3));
  events.end();
  assert.equal(metrics.reportedModel, 'test-model');
  assert.deepEqual(metrics.usage, {inputTokens: 10, cachedInputTokens: 3, outputTokens: 5, reasoningTokens: null});
  assert.ok(metrics.timingsMs.firstEvent >= 0);
  assert.ok(metrics.timingsMs.firstMessage >= 0);
  assert.equal(JSON.stringify(metrics).includes('私人'), false);
});

test('紧凑用料编号恢复名称/人数，已有与另备来源由服务确定，越界编号拒绝', () => {
  const request = {...input, ingredients: ['鸡肉 200克', '生菜']};
  assert.equal(ingredientCatalog(request)[0].name, '鸡肉');
  const value = expandRecipeOutput({e: '', x: ['香菇'], r: [{t: '鸡肉汤', m: 20, i: [[0, '100克'], [5, '2朵']], s: ['准备', '煮熟']}]}, request);
  assert.equal(value.recipes[0].servings, 2);
  assert.deepEqual(value.recipes[0].ingredients, [{name: '鸡肉', availability: 'provided', amount: '100克'}, {name: '香菇', availability: 'extra', amount: '2朵'}]);
  assert.throws(() => expandRecipeOutput({e: '', x: [], r: [{i: [[-1, '1份']]}]}, request), /用料编号/);
  assert.throws(() => expandRecipeOutput({e: '', x: [], r: [{i: [[2, '1勺']]}]}, request), /输入食材/);
});

test('菜谱库筛选遵守主料/时间/忌口，限定AI编号，并按人数及已知数量提供用料', () => {
  const request = {...input, ingredients: ['鸡肉 200克', '生菜', '蒜蓉', '姜蓉'], preferences: '清淡少油', avoid: '不放辣椒'};
  const candidates = catalogCandidates(request), protocol = catalogProtocol(request);
  assert.ok(candidates.length >= 3);
  assert.ok(candidates.every(recipe => recipe.minutes <= 30 && recipe.required.every(name => ['鸡肉', '生菜', '蒜蓉', '姜蓉'].includes(name))));
  const selected = protocol.decode({ids: candidates.slice(0, 3).map(recipe => recipe.id)});
  assert.equal(selected.recipes.length, 3);
  assert.ok(selected.recipes.every(recipe => recipe.steps.length >= 3));
  assert.throws(() => protocol.decode({ids: [candidates[0].id, candidates[0].id, candidates[1].id]}), /无效/);
  assert.throws(() => protocol.decode({ids: ['unknown', candidates[0].id, candidates[1].id]}), /无效/);
  const avoided = catalogCandidates({...request, avoid: '蒜过敏'});
  assert.ok(avoided.every(recipe => recipe.ingredients.every(([name]) => name !== '蒜蓉')));
  const vegan = catalogCandidates({...request, ingredients: ['鸡肉', '生菜', '鸡蛋', '油麦菜'], preferences: '纯素'});
  assert.ok(vegan.every(recipe => recipe.ingredients.every(([name]) => !['鸡肉', '鸡蛋'].includes(name))));
  assert.equal(catalogProtocol({...request, maxMinutes: 5}), null);
  assert.equal(catalogProtocol({...request, ingredients: ['不在库中的合成食材']}), null);
  const chicken = instantiateRecipe(recipeLibrary.find(recipe => recipe.id === 'c01'), request);
  assert.equal(chicken.ingredients.find(item => item.name === '鸡肉').amount, '200克');
  assert.equal(chicken.ingredients.find(item => item.name === '盐').availability, 'staple');
});

test('生成失败/损坏输出可重试；服务重启不自动重放，保留请求', async t => {
  let fail = true, calls = 0;
  const {queue, automation, directory} = await setup(t, async request => { calls++; if (fail) throw new RecipeError('额度不足', 502); return result(request); });
  await assert.rejects(automation.submit({...input, servings: 0}));
  const {request} = await automation.submit(input);
  await automation.idle();
  assert.equal((await automation.get(request.requestId)).job.status, 'failed');
  assert.equal((await queue.request(request.requestId)).ingredients[0], '合成食材');
  fail = false;
  await queue.setJob(request.requestId, 'running'); // Simulates an interrupted earlier process.
  assert.equal((await automation.get(request.requestId)).job.status, 'interrupted');
  assert.equal(calls, 1);
  await automation.retry(request.requestId); await automation.idle();
  assert.equal((await automation.get(request.requestId)).result.recipes.length, 3);
  // Explicit retry can repair a corrupt file without re-reading unrelated requests.
  await writeFile(path.join(directory, 'results', `${request.requestId}.json`), '{broken');
  await automation.retry(request.requestId); await automation.idle();
  assert.equal((await automation.get(request.requestId)).result.status, 'completed');
  assert.equal(calls, 3);
  await queue.complete(request.requestId, {...result(request), status: 'failed', error: '合成的条件不足失败'});
  await automation.retry(request.requestId);
  await automation.idle();
  assert.equal((await automation.get(request.requestId)).result.status, 'completed');
});

test('关闭服务会取消正在生成的任务并留下可重试状态', async t => {
  const {queue, automation} = await setup(t, async (_request, {signal}) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), {once: true})));
  const {request} = await automation.submit(input);
  await automation.close();
  assert.equal((await queue.get(request.requestId)).job.status, 'interrupted');
  await assert.rejects(automation.submit(input), /服务正在停止/);
});

test('CLI 适配使用固定参数/隔离目录/stdin，无 shell 拼接；解析结果且清理临时文件', async () => {
  const request = {requestId: '00000000-0000-4000-8000-000000000000', ...input, ingredients: ['合成食材']};
  let usedDirectory;
  const output = {e: '', x: [], r: result(request).recipes.map(recipe => ({t: recipe.title, m: recipe.minutes, i: [[0, '适量']], s: recipe.steps}))};
  const value = await generateWithCodex(request, {spawnProcess: (_command, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--output-schema']) assert.ok(args.includes(flag));
    for (const setting of ['features.shell_tool=false', 'features.hooks=false', 'features.apps=false', 'web_search="disabled"']) assert.ok(args.includes(setting));
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    usedDirectory = options.cwd;
    return spawn(process.execPath, ['-e', `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('合成食材'))process.exit(2);require('fs').writeFileSync('output.json',${JSON.stringify(JSON.stringify(output))});});`], options);
  }});
  assert.equal(value.requestId, request.requestId);
  assert.equal(value.recipes.length, 3);
  const {access} = await import('node:fs/promises');
  await assert.rejects(access(usedDirectory));
});

test('CLI 超时终止进程；CLI 未安装时明确失败', async () => {
  const request = {requestId: '00000000-0000-4000-8000-000000000000', ...input, ingredients: ['合成食材']};
  await assert.rejects(generateWithCodex(request, {timeoutMs: 30, spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options)}), /超过 3 分钟/);
  await assert.rejects(generateWithCodex(request, {command: '/nonexistent/pantry-codex-cli'}), /无法启动 Codex CLI/);
});

test('完整结构化消息加 turn.completed 后结束进程；只有消息但失败时不报成功', async () => {
  const request = {requestId: '00000000-0000-4000-8000-000000000000', ...input, ingredients: ['合成食材']};
  const wire = {e: '', x: [], r: [1, 2, 3].map(i => ({t: `合成菜${i}`, m: 10, i: [[0, '1份']], s: ['准备', '煮熟']}))};
  const events = [{type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(wire)}}, {type: 'turn.completed', usage: {input_tokens: 11, output_tokens: 9, reasoning_output_tokens: 0}}];
  let metrics;
  const start = performance.now();
  const value = await generateWithCodex(request, {onMetrics: m => metrics = m, spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', `process.stdin.resume();console.log(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});setInterval(()=>{},1000);`], options)});
  assert.equal(value.recipes.length, 3);
  assert.equal(metrics.stoppedAfterCompletion, true);
  assert.equal(metrics.usage.reasoningTokens, 0);
  assert.ok(performance.now() - start < 2000);
  await assert.rejects(generateWithCodex(request, {spawnProcess: (_command, _args, options) => spawn(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify(events[0]))});process.exit(2);`], options)}), /生成失败/);
  assert.throws(() => expandRecipeOutput({e: '', x: [], r: [{i: [[99, '1份']]}]}, request), /用料编号/);
});

function fakeModelProcess(mode, started = () => {}) {
  return (_command, args, options) => {
    assert.equal(args[0], 'app-server'); assert.equal(options.shell, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    const script = `
      const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});
      const calls=[];const send=x=>console.log(JSON.stringify(x));
      rl.on('line',line=>{const m=JSON.parse(line);if(!m.method)return;calls.push(m.method);fs.writeFileSync('calls.json',JSON.stringify(calls));
      const reply=result=>send({id:m.id,result});
      if(m.method==='initialize'||m.method==='thread/unsubscribe')reply({});
      if(m.method==='model/list')reply({data:[]});
      if(m.method==='config/read')reply({config:{mcp_servers:{test_connection:{command:'never-run'}}}});
      if(m.method==='thread/start'){
        const p=m.params;if(p.config.mcp_servers.test_connection.enabled!==false||p.sandbox!=='read-only'||!p.ephemeral||p.environments.length||p.runtimeWorkspaceRoots.length||p.dynamicTools.length)process.exit(3);
        reply({thread:{id:'test-thread'},model:'gpt-6-luna'});
      }
      if(m.method==='turn/start'){
        reply({turn:{id:'test-turn'}});send({method:'test/started',params:{threadId:'test-thread'}});
        if(${JSON.stringify(mode)}==='tool'){send({id:999,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread'}});return;}
        if(${JSON.stringify(mode)}==='hang')return;
        const text=JSON.stringify({ids:['c01','c04','l01']});
        send({method:'item/agentMessage/delta',params:{threadId:'test-thread',delta:text}});
        send({method:'thread/tokenUsage/updated',params:{threadId:'test-thread',tokenUsage:{last:{inputTokens:20,cachedInputTokens:0,outputTokens:9,reasoningOutputTokens:0}}}});
        send({method:'turn/completed',params:{threadId:'test-thread',turn:{status:'completed'}}});
      }});`;
    const child = spawn(process.execPath, ['-e', script], options);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('test/started')) started(); });
    return child;
  };
}

test('复用连接空闲不调用模型；临时任务禁用继承MCP且无环境工具，返回后清理目录', async () => {
  let directory;
  const spawnFake = fakeModelProcess('success');
  const worker = createRecipeModelWorker({spawnProcess: (command, args, options) => { directory = options.cwd; return spawnFake(command, args, options); }});
  try {
    await worker.start();
    const before = JSON.parse(await readFile(path.join(directory, 'calls.json'), 'utf8'));
    assert.equal(before.includes('turn/start'), false);
    const request = {...input, requestId: '00000000-0000-4000-8000-000000000000', ingredients: ['鸡肉 200克', '生菜', '姜蓉', '蒜蓉']};
    let metrics;
    const result = await worker.generate(request, {protocol: catalogProtocol(request), onMetrics: value => metrics = value});
    assert.equal(result.generation.mode, 'catalog'); assert.equal(result.recipes.length, 3);
    assert.equal(metrics.reportedModel, 'gpt-6-luna'); assert.equal(metrics.usage.outputTokens, 9);
    assert.ok(metrics.timingsMs.firstText >= 0);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'calls.json'), 'utf8')).filter(method => method === 'turn/start').length, 1);
  } finally { await worker.close(); }
  await assert.rejects(access(directory));
});

test('模型连接取消/意外工具请求明确失败并关闭，不留下并行模型任务', async () => {
  const request = {...input, requestId: '00000000-0000-4000-8000-000000000000', ingredients: ['鸡肉', '生菜', '姜蓉', '蒜蓉']}, protocol = catalogProtocol(request);
  let began; const started = new Promise(resolve => began = resolve);
  const worker = createRecipeModelWorker({spawnProcess: fakeModelProcess('hang', began)}), controller = new AbortController();
  const running = worker.generate(request, {protocol, signal: controller.signal});
  const rejected = assert.rejects(running, /中断/);
  await started;
  await assert.rejects(worker.generate(request, {protocol}), /其他推荐/);
  controller.abort(); await rejected; await worker.close();
  const toolWorker = createRecipeModelWorker({spawnProcess: fakeModelProcess('tool')});
  try { await assert.rejects(toolWorker.generate(request, {protocol}), /未授权工具/); }
  finally { await toolWorker.close(); }
});
