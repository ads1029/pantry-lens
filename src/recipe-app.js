import {recipeInput, validRequestId, validateRecipeResult} from './recipes.js';
import {ingredientGroups, ingredientCombos, ingredientList, hasIngredient, toggleIngredient, addIngredients} from './ingredient-presets.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const staticMode = document.documentElement.dataset.recipeMode === 'static';
const localMatcher = staticMode ? (await import('./static-recipes.js')).matchLocalRecipes : null;
const storageKey = staticMode ? 'pantry-lens-static-recipes-v1' : 'pantry-lens-recipe-request-v1';
let active = null, timer, generation = 0, deadline = 0, checking = false, working = false;
let measurement = null;
const pollMs = 250;
const availability = {provided: '已有食材', extra: '需补充', staple: '基础调味'};
let ingredientGroup = 0;

function renderIngredientPicker() {
  const value = $('#recipe-ingredients').value, count = ingredientList(value).length;
  $('#ingredient-count').textContent = count ? `已选 ${count} 种` : '';
  $('#ingredient-clear').disabled = count === 0;
  for (const button of document.querySelectorAll('[data-ingredient-group]')) button.setAttribute('aria-pressed', String(Number(button.dataset.ingredientGroup) === ingredientGroup));
  $('#ingredient-choices').innerHTML = ingredientGroups[ingredientGroup].items.map(name => `<button type="button" class="ingredient-choice" data-ingredient="${escape(name)}" aria-pressed="${hasIngredient(value, name)}">${escape(name)}</button>`).join('');
}
$('#ingredient-groups').innerHTML = ingredientGroups.map((group, index) => `<button type="button" data-ingredient-group="${index}" aria-pressed="${index === 0}">${escape(group.name)}</button>`).join('');
$('#ingredient-combos').innerHTML = ingredientCombos.map((combo, index) => `<button type="button" data-ingredient-combo="${index}">${escape(combo.name)}</button>`).join('');
function applyIngredients(value) {
  $('#recipe-ingredients').value = value;
  $('#recipe-form-error').hidden = true;
  renderIngredientPicker();
}
$('#ingredient-groups').onclick = event => {
  const button = event.target.closest('[data-ingredient-group]');
  if (!button) return;
  ingredientGroup = Number(button.dataset.ingredientGroup);
  renderIngredientPicker();
};
$('#ingredient-choices').onclick = event => {
  const button = event.target.closest('[data-ingredient]');
  if (!button) return;
  try {
    const name = button.dataset.ingredient;
    applyIngredients(toggleIngredient($('#recipe-ingredients').value, name));
    // Rendering replaces the toggled button; preserve keyboard focus on its replacement.
    [...document.querySelectorAll('[data-ingredient]')].find(item => item.dataset.ingredient === name)?.focus({preventScroll: true});
  } catch (failure) { $('#recipe-form-error').textContent = failure.message; $('#recipe-form-error').hidden = false; }
};
$('#ingredient-combos').onclick = event => {
  const button = event.target.closest('[data-ingredient-combo]');
  if (!button) return;
  try { applyIngredients(addIngredients($('#recipe-ingredients').value, ingredientCombos[Number(button.dataset.ingredientCombo)].items)); }
  catch (failure) { $('#recipe-form-error').textContent = failure.message; $('#recipe-form-error').hidden = false; }
};
$('#ingredient-clear').onclick = () => applyIngredients('');
$('#recipe-ingredients').addEventListener('input', renderIngredientPicker);
renderIngredientPicker();

// Quick preferences share the existing request field; custom wording stays optional.
const preferenceGroups = [['中式', '西式'], ['少油'], ['素食', '纯素']];
const preferenceOptions = preferenceGroups.flat();
const selectedPreferences = new Set();
const customPreference = $('#recipe-preferences');
const preferenceLabel = document.querySelector('label[for="recipe-preferences"]');
const preferenceChoices = document.createElement('div');
preferenceChoices.className = 'ingredient-choices preference-choices';
preferenceChoices.setAttribute('role', 'group');
preferenceChoices.setAttribute('aria-label', '常用偏好');
preferenceChoices.innerHTML = preferenceOptions.map(name => `<button type="button" class="ingredient-choice" data-preference="${name}" aria-pressed="false">${name}</button>`).join('');
const otherPreferences = document.createElement('details');
otherPreferences.className = 'other-preferences';
otherPreferences.innerHTML = '<summary>其他偏好</summary>';
preferenceLabel.before(preferenceChoices, otherPreferences);
preferenceLabel.classList.add('visually-hidden');
preferenceLabel.textContent = '其他偏好';
customPreference.placeholder = '例如：不要姜';
otherPreferences.append(preferenceLabel, customPreference);

function renderPreferences() {
  for (const button of preferenceChoices.querySelectorAll('[data-preference]')) {
    button.setAttribute('aria-pressed', String(selectedPreferences.has(button.dataset.preference)));
  }
}
function choosePreference(name) {
  for (const option of preferenceGroups.find(group => group.includes(name))) selectedPreferences.delete(option);
  selectedPreferences.add(name);
}
preferenceChoices.onclick = event => {
  const button = event.target.closest('[data-preference]');
  if (!button) return;
  const name = button.dataset.preference;
  if (selectedPreferences.has(name)) selectedPreferences.delete(name);
  else choosePreference(name);
  renderPreferences();
};
function restorePreferences(value) {
  selectedPreferences.clear();
  const custom = [], presets = new Set();
  for (const clause of String(value ?? '').split(/[、,，;；\n]+/).map(part => part.trim()).filter(Boolean)) {
    const tokens = clause.split(/\s+/);
    if (tokens.every(token => preferenceOptions.includes(token))) tokens.forEach(token => presets.add(token));
    else custom.push(clause);
  }
  // Restore legacy requests with both cuisines as unrestricted, and both diets as vegan.
  if (presets.has('中式') && presets.has('西式')) { presets.delete('中式'); presets.delete('西式'); }
  if (presets.has('纯素')) presets.delete('素食');
  for (const name of presets) selectedPreferences.add(name);
  customPreference.value = custom.join('、');
  renderPreferences();
}
function currentPreferences() {
  return [...selectedPreferences, customPreference.value.trim()].filter(Boolean).join('、');
}

function showView(recipes) {
  $('#recipes-view').hidden = !recipes;
  $('#pantry-view').hidden = recipes;
  $('#recipes-tab').setAttribute('aria-pressed', String(recipes));
  $('#pantry-tab').setAttribute('aria-pressed', String(!recipes));
}
$('#recipes-tab').onclick = () => showView(true);
$('#pantry-tab').onclick = () => showView(false);

async function api(url, options = {}) {
  const response = await fetch(url, {...options, headers: {'Content-Type': 'application/json', 'X-Pantry-Local': '1'}, signal: AbortSignal.timeout(10000)});
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '本机服务暂时不可用。');
  return body;
}
function saveActive(id) { try { localStorage.setItem(storageKey, id); } catch { /* The flow still works without persistence. */ } }
function setWorking(value) {
  working = value;
  $('#recipe-submit').disabled = value;
  $('#recipe-submit').innerHTML = value ? '推荐中… <span>◌</span>' : '推荐三道 <span>↗</span>';
}
function handoff(request) {
  active = request;
  $('#recipe-handoff').hidden = false;
  $('#recipe-retry').hidden = true;
  $('#recipe-job-description').textContent = '食材已保存，AI 正在挑选或生成三道推荐。完成后会显示在这里。';
}
function renderPending(body) {
  const job = body.job;
  $('#recipe-handoff').hidden = false;
  const running = job?.status === 'running';
  setWorking(running);
  $('#recipe-retry').hidden = running;
  $('#recipe-badge').textContent = running ? 'AI 正在推荐' : '等待重试';
  $('#recipe-state').textContent = `本次食材：${active.ingredients.join('、')} · ${active.servings} 人份。`;
  $('#recipe-job-description').textContent = running ? 'AI 正在挑选或生成三道推荐，完整做法会直接显示在这里。' : job?.error || '这个请求尚未自动处理，点击“重试生成”即可。';
  if (running && Date.now() < deadline) timer = setTimeout(() => { if (!document.hidden) void check(); }, pollMs);
  else if (running) {
    setWorking(false);
    $('#recipe-job-description').textContent = '自动检查已暂停，点击“检查进度”可重新连接当前任务。';
  }
}
function error(message) {
  $('#recipe-state').textContent = message;
  $('#recipe-badge').textContent = '需要检查';
  setWorking(false);
  if (active) { $('#recipe-handoff').hidden = false; $('#recipe-retry').hidden = false; }
}
function showMetrics(metrics) {
  $('#recipe-timing').hidden = !metrics;
  if (!metrics) return;
  const duration = value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : '未报告';
  const tokens = value => value == null ? '未报告' : String(value);
  const rows = [['点击至显示', duration(metrics.browser?.totalMs)], ['后台总耗时', duration(metrics.timingsMs?.backend)], ['模型等待与输出', duration(metrics.timingsMs?.modelRequest ?? metrics.timingsMs?.cli)], ['首个任务事件（非首字）', duration(metrics.timingsMs?.firstEvent)], ['收到首段 AI 文字', duration(metrics.timingsMs?.firstText)], ['结果读取与解析', duration(metrics.timingsMs?.parse)], ['校验与保存', duration(metrics.timingsMs?.resultSave)], ['指定模型 / 推理强度', `${metrics.configuredModel ?? '未报告'} / ${metrics.reasoningEffort ?? '未报告'}`], ['输入 / 缓存 / 输出 / 推理 token', [metrics.usage?.inputTokens, metrics.usage?.cachedInputTokens, metrics.usage?.outputTokens, metrics.usage?.reasoningTokens].map(tokens).join(' / ')]];
  $('#recipe-timing-content').innerHTML = rows.map(([name, value]) => `<div><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`).join('');
}
function renderResult(result, metrics) {
  const renderStart = performance.now();
  clearTimeout(timer);
  setWorking(false);
  $('#recipe-handoff').hidden = true;
  if (result.status === 'failed') {
    $('#recipe-results').replaceChildren();
    $('#recipe-handoff').hidden = false;
    error(`这次推荐未完成：${result.error}。可以点击“重试生成”。`);
    return;
  }
  $('#recipe-badge').textContent = staticMode ? '本地匹配 · 家常菜谱库' : result.generation?.mode === 'catalog' ? 'AI 挑选 · 家常菜谱库' : 'AI 现场生成 · 3 道';
  $('#recipe-state').textContent = `${active.servings} 人份 · 三道备选`;
  $('#recipe-results').innerHTML = result.recipes.map(recipe => `<article class="recipe-card">
    <div class="recipe-card-top"><h3>${escape(recipe.title)}</h3><span>${recipe.minutes} 分钟</span></div>
    <ul class="recipe-ingredients">${recipe.ingredients.map(item => `<li><span>${escape(item.name)} <small>${escape(item.amount)}</small></span>${item.availability === 'extra' ? '<em class="ingredient-extra">另备</em>' : `<em class="visually-hidden">${availability[item.availability]}</em>`}</li>`).join('')}</ul>
    <details><summary>做法</summary><ol class="recipe-steps">${recipe.steps.map(step => `<li>${escape(step)}</li>`).join('')}</ol><p class="recipe-tip">${escape(recipe.tips)}</p></details>
  </article>`).join('');
  showMetrics(metrics);
  const captured = measurement, id = active.requestId;
  if (captured?.requestId === id && metrics?.attemptId && !captured.reported) {
    captured.reported = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      if (active?.requestId !== id) return;
      const totalMs = performance.now() - captured.start;
      try {
        const body = await api(`/api/recipes/requests/${id}/displayed`, {method: 'POST', body: JSON.stringify({attemptId: metrics.attemptId, totalMs, acceptedMs: captured.acceptedMs, afterAcceptedMs: totalMs - captured.acceptedMs, renderMs: performance.now() - renderStart})});
        if (active?.requestId === id) showMetrics(body.metrics);
      } catch { /* Displaying a recipe must not depend on diagnostic writes. */ }
    }));
  }
}
async function check() {
  if (!active || checking) return;
  const version = generation, request = active;
  checking = true;
  clearTimeout(timer);
  $('#recipe-check').disabled = true;
  try {
    const body = await api(`/api/recipes/requests/${request.requestId}`);
    if (version !== generation) return;
    if (body.status === 'ready') { renderResult(validateRecipeResult(body.result, request), body.metrics); return; }
    if (body.status !== 'pending') throw Error('本机服务返回了未知状态。');
    renderPending(body);
  } catch (failure) {
    if (version === generation) error(`${failure.message} 可点击“检查进度”重新连接。`);
  } finally {
    checking = false;
    $('#recipe-check').disabled = false;
    if (version !== generation && active) timer = setTimeout(() => void check(), pollMs);
  }
}
$('#recipe-form').onsubmit = async event => {
  event.preventDefault();
  const button = $('#recipe-submit');
  button.disabled = true;
  $('#recipe-form-error').hidden = true;
  // Invalidate in-flight polls before submission; only this response can become active.
  const version = ++generation;
  measurement = {start: performance.now(), requestId: null, acceptedMs: null, reported: false};
  clearTimeout(timer);
  try {
    const input = recipeInput({ingredients: $('#recipe-ingredients').value, servings: Number($('#recipe-servings').value), maxMinutes: Number($('#recipe-minutes').value), preferences: currentPreferences(), avoid: $('#recipe-avoid').value});
    if (staticMode) {
      const request = {...input, schemaVersion: 1, requestId: crypto.randomUUID(), createdAt: new Date().toISOString()};
      const result = localMatcher(request);
      active = request; measurement = null;
      renderResult(result);
      try { localStorage.setItem(storageKey, JSON.stringify({request, result})); } catch { /* Matching works without storage. */ }
      return;
    }
    const body = await api('/api/recipes/requests', {method: 'POST', body: JSON.stringify(input)});
    if (version !== generation) return;
    handoff(body.request);
    measurement.requestId = active.requestId; measurement.acceptedMs = performance.now() - measurement.start;
    saveActive(active.requestId);
    $('#recipe-results').replaceChildren();
    $('#recipe-timing').hidden = true;
    $('#recipe-badge').textContent = 'AI 正在推荐';
    deadline = Date.now() + 10 * 60 * 1000;
    // A previous request can still be completing its fetch; this new poll runs afterward.
    renderPending(body);
  } catch (failure) {
    $('#recipe-form-error').textContent = failure.message;
    $('#recipe-form-error').hidden = false;
    if (active && !staticMode) timer = setTimeout(() => void check(), pollMs);
  } finally { button.disabled = working; }
};
$('#recipe-check').onclick = () => { deadline = Date.now() + 10 * 60 * 1000; void check(); };
$('#recipe-retry').onclick = async () => {
  if (!active) return;
  const version = ++generation;
  measurement = {start: performance.now(), requestId: active.requestId, acceptedMs: null, reported: false};
  clearTimeout(timer);
  $('#recipe-retry').disabled = true;
  setWorking(true);
  try {
    const body = await api(`/api/recipes/requests/${active.requestId}/retry`, {method: 'POST'});
    if (version !== generation) return;
    measurement.acceptedMs = performance.now() - measurement.start;
    deadline = Date.now() + 10 * 60 * 1000;
    if (body.status === 'ready') { measurement = null; renderResult(validateRecipeResult(body.result, active), body.metrics); }
    else renderPending(body);
  } catch (failure) { if (version === generation) error(failure.message); }
  finally { $('#recipe-retry').disabled = false; }
};
$('#recipe-download').onclick = () => {
  if (!active) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(active, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `recipe-request-${active.requestId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('visibilitychange', () => { if (!staticMode && !document.hidden && active && !$('#recipe-handoff').hidden && Date.now() < deadline) void check(); });

let saved;
try { saved = localStorage.getItem(storageKey); } catch { /* Optional resume. */ }
if (staticMode && saved) {
  try {
    const {request, result} = JSON.parse(saved);
    recipeInput(request);
    if (!validRequestId(request.requestId) || result.source !== 'local-catalog') throw Error('保存的推荐格式无效，请重新匹配。');
    const checked = validateRecipeResult(result, request, {allowLocalCatalog: true});
    active = request;
    $('#recipe-ingredients').value = request.ingredients.join('、');
    renderIngredientPicker();
    $('#recipe-servings').value = String(request.servings);
    $('#recipe-minutes').value = String(request.maxMinutes);
    restorePreferences(request.preferences);
    $('#recipe-avoid').value = request.avoid;
    renderResult(checked);
  } catch { $('#recipe-form-error').textContent = '上次推荐未能恢复，请重新选择食材。'; $('#recipe-form-error').hidden = false; }
}
if (!staticMode && validRequestId(saved)) {
  const version = generation;
  try {
    const body = await api(`/api/recipes/requests/${saved}`), request = body.request;
    if (version === generation) {
    recipeInput(request);
    handoff(request);
    $('#recipe-ingredients').value = request.ingredients.join('、');
    renderIngredientPicker();
    $('#recipe-servings').value = String(request.servings);
    $('#recipe-minutes').value = String(request.maxMinutes);
    restorePreferences(request.preferences);
    $('#recipe-avoid').value = request.avoid;
    deadline = Date.now() + 10 * 60 * 1000;
    if (body.status === 'ready') renderResult(validateRecipeResult(body.result, request), body.metrics);
    else { renderPending(body); }
    }
  } catch (failure) { if (version === generation) error(`上次请求未能恢复：${failure.message} 仍可重新提交食材。`); }
}
