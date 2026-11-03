import {catalogCandidates, instantiateRecipe, recipeLibraryVersion} from '../recipe-catalog.mjs';
import {recipeInput, validateRecipeResult} from './recipes.js';

// Deterministic browser matching. No model, API, timers, or network requests.
export function matchLocalRecipes(request) {
  recipeInput(request);
  if (request.servings > 4) throw Error('在线菜谱库支持1–4人，请调整人数后重试。');
  let candidates = catalogCandidates(request);
  if (/少油|低油|低脂/.test(request.preferences)) candidates = candidates.filter(recipe => recipe.ingredients.filter(([name]) => /油/.test(name)).reduce((sum, [, amount]) => sum + amount, 0) <= 5);
  if (candidates.length < 3) throw Error(`当前菜谱库仅匹配到${candidates.length}道，未凑满三道。请增加食材或放宽时间；可试鸡肉＋生菜、鸡蛋＋豆腐。忌口不会自动放宽。`);
  const selected = [], covered = new Set();
  while (selected.length < 3) {
    candidates.sort((a, b) => score(b) - score(a) || a.minutes - b.minutes || a.id.localeCompare(b.id));
    const recipe = candidates.shift(); selected.push(recipe);
    for (const name of recipe.used) covered.add(name);
  }
  function score(recipe) { return recipe.used.filter(name => !covered.has(name)).length * 5 + recipe.used.length * 2 - recipe.extra.length * 2; }
  return validateRecipeResult({schemaVersion: 1, requestId: request.requestId, source: 'local-catalog', generatedAt: new Date().toISOString(), generation: {mode: 'catalog', libraryVersion: recipeLibraryVersion}, status: 'completed', recipes: selected.map(recipe => instantiateRecipe(recipe, request))}, request, {allowLocalCatalog: true});
}
