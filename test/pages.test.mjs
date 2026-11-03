import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recipeInput, validateRecipeResult} from '../src/recipes.js';
import {matchLocalRecipes} from '../src/static-recipes.js';
import {buildPages, publicFiles} from '../scripts/build-pages.mjs';
import {ingredientGroups} from '../src/ingredient-presets.js';
import {recipeLibrary, catalogCandidates} from '../recipe-catalog-expanded.mjs';
import {ingredientName} from '../recipe-ingredients.mjs';

test('5000份菜谱的名称/编号唯一；新增搭配温和、少添加油盐，步骤与主食不缺失', () => {
  assert.equal(recipeLibrary.length, 5000);
  assert.equal(new Set(recipeLibrary.map(recipe => recipe.id)).size, 5000);
  assert.equal(new Set(recipeLibrary.map(recipe => recipe.title)).size, 5000);
  const added = recipeLibrary.filter(recipe => recipe.kind);
  assert.equal(added.length, 4808);
  assert.equal(new Set(added.map(recipe => JSON.stringify([recipe.ingredients,recipe.steps]))).size,4808);
  assert.equal(added.filter(recipe => recipe.cuisine === 'western').length, 2404);
  for (const recipe of added) {
    assert.equal(recipe.spice, 'mild');
    assert.equal(recipe.steps.length, 4);
    assert.equal(new Set(recipe.ingredients.map(([name]) => name)).size, recipe.ingredients.length);
    assert.ok(!recipe.ingredients.some(([name]) => /辣椒|辣酱|黄油|奶油|糖/.test(name)));
    assert.ok(recipe.ingredients.filter(([name]) => /油$/.test(name)).reduce((sum, [, amount]) => sum + amount, 0) <= 5);
    assert.ok(recipe.ingredients.find(([name]) => name === '盐')[1] <= 0.8);
    assert.ok(recipe.minutes >= 25 && recipe.minutes <= 45);
  }
});

test('中式/西式偏好可筛选；主菜不因只换主食重复推荐，过敏与英文食材仍有效', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  for (const p of ['鸡肉','猪肉','牛肉','鱼肉','虾','鸡蛋','豆腐','鹰嘴豆']) for (const v of ['西兰花','西葫芦','南瓜','茄子','四季豆','豌豆','玉米']) for (const cuisine of ['中式','西式']) {
    const request = {ingredients:[p,v],servings:2,maxMinutes:45,preferences:cuisine+' 少油',avoid:'',requestId:id};
    assert.equal(matchLocalRecipes(request).recipes.length,3,`${p}+${v}+${cuisine}`);
    const candidates=catalogCandidates(request);
    assert.ok(candidates.every(recipe => (recipe.cuisine ?? 'chinese') === (cuisine==='中式'?'chinese':'western')));
    assert.equal(new Set(candidates.map(recipe=>recipe.family??recipe.id)).size,candidates.length);
  }
  const candidates=catalogCandidates({ingredients:['豆腐','鹰嘴豆','鸡蛋','西兰花'],servings:2,maxMinutes:45,preferences:'西式 纯素',avoid:'小麦、蒜、芝麻'});
  assert.ok(candidates.length>=3);
  assert.ok(candidates.every(recipe=>recipe.ingredients.every(([name])=>!['鸡蛋','面条','全麦意面','蒜蓉','芝麻油'].includes(name))));
  assert.equal(ingredientName('Zucchini 300g'),'西葫芦');
  assert.equal(ingredientName('Chickpeas 300g'),'鹰嘴豆');
});

test('三种肉类×14种蔬菜均能返回三道同时包含两种主料的菜，蔬菜单选也可匹配', () => {
  const vegetables = ingredientGroups.find(group => group.name === '蔬菜菌菇').items;
  for (const meat of ['鸡肉', '猪肉', '牛肉']) for (const vegetable of vegetables) {
    const request = {...recipeInput({ingredients: [meat, vegetable], servings: 2, maxMinutes: 30, preferences: '少油', avoid: '蒜、姜、芝麻过敏'}), requestId: '00000000-0000-4000-8000-000000000001'};
    const result = matchLocalRecipes(request);
    assert.equal(new Set(result.recipes.map(recipe => recipe.title)).size, 3);
    for (const recipe of result.recipes) {
      const names = recipe.ingredients.map(item => item.name);
      assert.ok(names.includes(meat) && names.includes(vegetable), `${meat}+${vegetable}: ${recipe.title}`);
      assert.ok(!names.some(name => ['蒜蓉', '姜蓉', '芝麻油'].includes(name)));
      assert.ok(recipe.minutes <= 30 && recipe.steps.length >= 3);
    }
  }
  for (const vegetable of vegetables) assert.equal(matchLocalRecipes({ingredients: [vegetable], servings: 1, maxMinutes: 30, preferences: '纯素', avoid: '', requestId: '00000000-0000-4000-8000-000000000001'}).recipes.length, 3);
});

test('静态匹配真实来源、三道完整结果及数量；不足三道或忌口不放宽，本机协议拒绝冒充', () => {
  const request = {...recipeInput({ingredients: '鸡肉200克、生菜、蒜蓉、姜蓉', servings: 2, maxMinutes: 30, preferences: '少油', avoid: '芝麻过敏'}), requestId: '00000000-0000-4000-8000-000000000001'};
  const result = matchLocalRecipes(request);
  assert.equal(result.source, 'local-catalog');
  assert.equal(new Set(result.recipes.map(recipe => recipe.title)).size, 3);
  assert.deepEqual(matchLocalRecipes(request).recipes, result.recipes);
  for (const recipe of result.recipes) {
    assert.equal(recipe.steps.length, 3);
    assert.ok(recipe.minutes <= request.maxMinutes);
    assert.ok(!recipe.ingredients.some(item => item.name.includes('芝麻')));
    for (const item of recipe.ingredients.filter(item => item.name === '鸡肉')) assert.ok(Number.parseFloat(item.amount) <= 200);
  }
  assert.throws(() => validateRecipeResult(result, request), /来源/);
  assert.equal(validateRecipeResult(result, request, {allowLocalCatalog: true}).source, 'local-catalog');
  for (const change of [{ingredients: ['蘑菇']}, {servings: 6}, {maxMinutes: 5}, {avoid: '鸡肉、生菜过敏'}]) assert.throws(() => matchLocalRecipes({...request, ...change}));
});

test('Pages仅发布白名单、子路径相对资源；浏览器模块不依赖Node或运行数据', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pantry-pages-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const output = path.join(directory, 'site');
  await buildPages(output);
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.ok(html.includes('data-recipe-mode="static"'));
  assert.ok(html.includes('不调用AI、不上传食材'));
  assert.ok(!/(?:href|src)="\//.test(html));
  assert.ok(!html.includes('src/app.js') && !html.includes('id="photos"'));
  const files = (await readdir(output, {recursive: true, withFileTypes: true})).filter(entry => entry.isFile()).map(entry => path.relative(output, path.join(entry.parentPath, entry.name))).sort();
  assert.deepEqual(files, ['index.html', '.nojekyll', ...publicFiles].sort());
  for (const filename of publicFiles.filter(name => /\.(?:mjs|js)$/.test(name))) {
    const source = await readFile(path.join(output, filename), 'utf8');
    assert.ok(!/from ['"]node:/.test(source), filename);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const resolved = path.relative(output, path.resolve(path.dirname(path.join(output, filename)), match[1]));
      assert.ok(publicFiles.includes(resolved), `${filename} → ${resolved}`);
    }
  }
});
