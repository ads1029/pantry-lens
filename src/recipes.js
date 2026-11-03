// Shared contract: the browser and local file bridge validate the same payloads.
export const RECIPE_VERSION = 1;
export function text(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${label}不能为空，且最多 ${max} 字。`);
  return value.trim();
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label}须为 ${min}–${max} 的整数。`);
  return value;
}
function optionalText(value, label) {
  if (value == null || (typeof value === 'string' && !value.trim())) return '';
  return text(value, label, 300);
}
export function recipeInput(input) {
  if (!input || typeof input !== 'object') throw Error('食材请求格式错误。');
  if (!Array.isArray(input.ingredients) && typeof input.ingredients !== 'string') throw Error('食材须为文字或文字列表。');
  const ingredients = Array.isArray(input.ingredients) ? input.ingredients : input.ingredients.split(/[\n,，;；、]+/).filter(v => v.trim());
  const names = [...new Set(ingredients.map(v => text(v, '食材', 80)))];
  if (!names.length || names.length > 30) throw Error('请输入 1–30 种食材，用逗号或换行分隔。');
  return {
    ingredients: names,
    servings: integer(input.servings, '用餐人数', 1, 8),
    maxMinutes: integer(input.maxMinutes, '做饭时间', 5, 180),
    preferences: optionalText(input.preferences, '口味偏好'),
    avoid: optionalText(input.avoid, '忌口'),
  };
}
export function validRequestId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
}
export function validateRecipeResult(result, request, {allowLocalCatalog = false} = {}) {
  const localCatalog = allowLocalCatalog && result?.source === 'local-catalog' && result?.generation?.mode === 'catalog';
  if (!result || result.schemaVersion !== RECIPE_VERSION || result.requestId !== request.requestId || (!localCatalog && result.source !== 'codex')) throw Error('结果版本、来源或请求编号不匹配。');
  if (typeof result.generatedAt !== 'string' || !Number.isFinite(Date.parse(result.generatedAt))) throw Error('结果缺少有效生成时间。');
  let generation;
  if (result.generation) {
    if (!['catalog', 'fresh'].includes(result.generation.mode)) throw Error('生成方式无效。');
    generation = {mode: result.generation.mode};
    if (generation.mode === 'catalog') generation.libraryVersion = text(result.generation.libraryVersion, '菜谱库版本', 40);
  }
  if (result.status === 'failed') return {schemaVersion: RECIPE_VERSION, requestId: request.requestId, source: result.source, generatedAt: result.generatedAt, status: 'failed', error: text(result.error, '失败原因')};
  if (result.status !== 'completed' || !Array.isArray(result.recipes) || result.recipes.length !== 3) throw Error('结果必须包含恰好三道食谱。');
  const recipes = result.recipes.map(recipe => {
    if (!recipe || typeof recipe !== 'object') throw Error('食谱格式错误。');
    const title = text(recipe.title, '菜名', 80), reason = text(recipe.reason, '推荐理由', 300);
    const minutes = integer(recipe.minutes, '烹饪分钟数', 1, request.maxMinutes);
    if (recipe.servings !== request.servings) throw Error('食谱人数与请求不一致。');
    if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 30) throw Error('每道食谱须包含 1–30 项用料。');
    const ingredients = recipe.ingredients.map(item => {
      if (!item || !['provided', 'extra', 'staple'].includes(item.availability)) throw Error('用料须标明已有食材、需补充或基础调味。');
      return {name: text(item.name, '用料名称', 80), amount: text(item.amount, '用料份量', 80), availability: item.availability};
    });
    if (!Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 15) throw Error('每道食谱须包含 1–15 个步骤。');
    const steps = recipe.steps.map(step => text(step, '烹饪步骤', 600));
    const tips = text(recipe.tips, '烹饪提示', 500);
    return {title, reason, minutes, servings: request.servings, ingredients, steps, tips};
  });
  if (new Set(recipes.map(r => r.title)).size !== 3) throw Error('请提供三道不同的食谱。');
  return {schemaVersion: RECIPE_VERSION, requestId: request.requestId, source: result.source, generatedAt: result.generatedAt, status: 'completed', recipes, ...(generation ? {generation} : {})};
}
