const aliases = new Map([['鸡胸肉', '鸡肉'], ['鸡腿肉', '鸡肉'], ['猪里脊', '猪肉'], ['猪瘦肉', '猪肉'], ['牛里脊', '牛肉'], ['蒜末', '蒜蓉'], ['姜末', '姜蓉'], ['上海青', '小白菜'], ['鲜香菇', '香菇']]);
const quantity = /\s*(\d+(?:\.\d+)?)\s*(千克|公斤|毫升|克|升|个|只|块|根|片|斤|两|袋|盒|份|kg|ml|g|l)/i;
export function ingredientName(value) {
  const name = value.replace(new RegExp(quantity.source + '.*', 'i'), '').trim() || value.trim();
  return aliases.get(name) ?? name;
}
export function ingredientLimit(value) {
  const match = value.match(quantity);
  if (!match) return null;
  const n = Number(match[1]), unit = match[2].toLowerCase();
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  if (['千克', '公斤', 'kg'].includes(unit)) return {value: n * 1000, unit: '克'};
  if (['升', 'l'].includes(unit)) return {value: n * 1000, unit: '毫升'};
  return {value: n, unit: unit === 'g' ? '克' : unit === 'ml' ? '毫升' : unit};
}
