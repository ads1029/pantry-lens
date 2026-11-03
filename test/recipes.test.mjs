import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recipeInput, validateRecipeResult} from '../src/recipes.js';
import {createRecipeQueue} from '../recipe-queue.mjs';
import {createPantryServer} from '../server.mjs';
import {ingredientGroups, ingredientCombos, ingredientList, hasIngredient, toggleIngredient, addIngredients} from '../src/ingredient-presets.js';

const input = {ingredients: '番茄、鸡蛋、豆腐，', servings: 2, maxMinutes: 30, preferences: '少油', avoid: ''};
// Contract fixtures only; not AI output and never served to the application.
const fixture = request => ({schemaVersion: 1, requestId: request.requestId, source: 'codex', status: 'completed', generatedAt: '2026-11-02T00:00:00Z', recipes: [1, 2, 3].map(n => ({title: `合成测试菜 ${n}`, reason: '仅用于接口测试', minutes: 15, servings: 2, ingredients: [{name: '番茄', amount: '1个', availability: 'provided'}], steps: ['测试步骤'], tips: '合成数据'}))});

test('点选食材与手填份量共存，取消/搭配不误删、不重复，并沿用30种上限', () => {
  const options = ingredientGroups.flatMap(group => group.items);
  for (const name of ['鸡肉', '猪肉', '牛肉', '生菜', '油麦菜', '蒜蓉', '姜蓉']) assert.ok(options.includes(name));
  let value = toggleIngredient('自选材料；鸡肉 200克', '生菜');
  assert.equal(hasIngredient(value, '鸡肉'), true);
  value = toggleIngredient(value, '鸡肉');
  assert.deepEqual(ingredientList(value), ['自选材料', '生菜']);
  value = addIngredients(value, ingredientCombos[0].items);
  assert.deepEqual(recipeInput({...input, ingredients: value}).ingredients, ['自选材料', '生菜', '蒜蓉']);
  assert.equal(addIngredients(value, ingredientCombos[0].items), value);
  assert.equal(hasIngredient('牛肉丸', '牛肉'), false);
  assert.equal(hasIngredient('鸡肉200克', '鸡肉'), true);
  const full = Array.from({length: 30}, (_, i) => `材料${i}`).join('、');
  assert.throws(() => toggleIngredient(full, '鸡肉'), /30/);
  assert.throws(() => addIngredients(full, ['鸡肉', '蒜蓉']), /30/);
});

test('食材请求去重，人数/时间/类型有界，空输入拒绝', () => {
  assert.deepEqual(recipeInput({...input, ingredients: '番茄、番茄\n鸡蛋；'}).ingredients, ['番茄', '鸡蛋']);
  for (const change of [{ingredients: ''}, {ingredients: {}}, {ingredients: [3]}, {servings: 0}, {maxMinutes: 181}, {avoid: {x: 1}}]) assert.throws(() => recipeInput({...input, ...change}));
});
test('结果限定三道不同食谱，拒绝错配、越界、缺步骤及来源伪装', () => {
  const request = {requestId: 'a', servings: 2, maxMinutes: 30};
  assert.equal(validateRecipeResult(fixture(request), request).recipes.length, 3);
  for (const mutate of [r => r.requestId = 'b', r => r.source = 'fixture', r => r.recipes.pop(), r => r.recipes[1].title = r.recipes[0].title, r => r.recipes[0].minutes = 31, r => r.recipes[0].servings = 3, r => r.recipes[0].steps = [], r => r.recipes[0].ingredients[0].availability = '<script>']) {
    const value = fixture(request); mutate(value); assert.throws(() => validateRecipeResult(value, request));
  }
  assert.equal(validateRecipeResult({...fixture(request), status: 'failed', error: '无法满足忌口'}, request).status, 'failed');
});
test('本机 HTTP → 请求文件 → 结果校验 → 读取；损坏输入不改请求且可恢复', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pantry-recipe-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const queue = createRecipeQueue(directory), server = createPantryServer({recipes: queue});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {'Content-Type': 'application/json', 'X-Pantry-Local': '1'};
  const response = await fetch(`${base}/api/recipes/requests`, {method: 'POST', headers, body: JSON.stringify(input)});
  assert.equal(response.status, 201);
  const {request} = await response.json(), url = `${base}/api/recipes/requests/${request.requestId}`;
  const original = await readFile(path.join(directory, 'requests', `${request.requestId}.json`), 'utf8');
  assert.deepEqual(JSON.parse(original), request);
  assert.equal((await (await fetch(url, {headers})).json()).status, 'pending');
  assert.equal((await queue.pending()).length, 1);
  await assert.rejects(queue.complete(request.requestId, {...fixture(request), requestId: 'wrong'}));
  await mkdir(path.join(directory, 'results'), {recursive: true});
  await writeFile(path.join(directory, 'results', `${request.requestId}.json`), '{broken');
  assert.equal((await fetch(url, {headers})).status, 422);
  assert.equal((await queue.pending())[0].status, 'invalid');
  await queue.complete(request.requestId, fixture(request));
  const ready = await (await fetch(url, {headers})).json();
  assert.equal(ready.result.recipes.length, 3);
  await assert.rejects(queue.complete(request.requestId, {...fixture(request), recipes: []}));
  assert.deepEqual((await queue.get(request.requestId)).result, ready.result);
  assert.equal((await queue.pending()).length, 0);
  assert.equal(await readFile(path.join(directory, 'requests', `${request.requestId}.json`), 'utf8'), original);
  for (const [route, options, status] of [
    ['/api/recipes/requests', {method: 'POST', headers: {...headers, Origin: 'https://example.com'}, body: '{}'}, 403],
    ['/api/recipes/requests', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}, 403],
    ['/api/recipes/requests', {method: 'POST', headers, body: '{broken'}, 400],
    ['/api/recipes/requests', {method: 'POST', headers, body: JSON.stringify({})}, 400],
    ['/api/recipes/requests', {method: 'POST', headers, body: 'x'.repeat(65537)}, 413],
    ['/api/recipes/requests/../../../README.md', {headers}, 404],
    ['/api/recipes/requests/not-a-uuid', {headers}, 404],
    ['/api/recipes/requests/00000000-0000-4000-8000-000000000000', {headers}, 404],
    [`/runtime/recipes/requests/${request.requestId}.json`, {}, 404],
    ['/recipe-queue.mjs', {}, 404],
    ['/src/recipes.js', {}, 200],
    ['/src/recipe-app.js', {}, 200],
    ['/src/ingredient-presets.js', {}, 200],
  ]) assert.equal((await fetch(base + route, options)).status, status, route);
});
