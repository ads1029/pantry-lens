export const ingredientGroups = [
  {name: '肉蛋豆类', items: ['鸡肉', '猪肉', '牛肉', '排骨', '鱼肉', '虾', '鸡蛋', '豆腐']},
  {name: '蔬菜菌菇', items: ['生菜', '油麦菜', '小白菜', '白菜', '菠菜', '西兰花', '番茄', '土豆', '胡萝卜', '黄瓜', '青椒', '洋葱', '香菇', '金针菇']},
  {name: '葱姜调味', items: ['蒜蓉', '姜蓉', '葱', '香菜', '辣椒', '生抽', '蚝油', '料酒', '黑胡椒', '醋', '芝麻油']},
  {name: '米面主食', items: ['米饭', '面条', '米粉', '粉丝', '馒头']},
];
export const ingredientCombos = [
  {name: '蒜蓉青菜', items: ['生菜', '蒜蓉']},
  {name: '番茄鸡蛋', items: ['番茄', '鸡蛋']},
  {name: '姜葱鸡肉', items: ['鸡肉', '姜蓉', '葱']},
  {name: '洋葱牛肉', items: ['牛肉', '洋葱']},
];

export function ingredientList(value) {
  return [...new Set(value.split(/[\n,，;；、]+/).map(item => item.trim()).filter(Boolean))];
}
// A quantity/note after a name still refers to that ingredient; 牛肉丸 is not 牛肉.
function matches(item, name) {
  return item === name || (item.startsWith(name) && /^[\s\d（(]/u.test(item.slice(name.length)));
}
export function hasIngredient(value, name) {
  return ingredientList(value).some(item => matches(item, name));
}
function checked(items) {
  if (items.length > 30) throw Error('每次最多选择 30 种食材，请先移除一些。');
  return items.join('、');
}
export function toggleIngredient(value, name) {
  const items = ingredientList(value);
  return checked(items.some(item => matches(item, name)) ? items.filter(item => !matches(item, name)) : [...items, name]);
}
export function addIngredients(value, names) {
  const items = ingredientList(value);
  for (const name of names) if (!items.some(item => matches(item, name))) items.push(name);
  return checked(items);
}
