import {readFile, stat} from 'node:fs/promises';
import {createRecipeQueue, MAX_RECIPE_BYTES} from './recipe-queue.mjs';
const queue = createRecipeQueue(), [action, id, filename] = process.argv.slice(2);
try {
  let result;
  if (action === 'pending') result = await queue.pending();
  else if (action === 'show') result = await queue.request(id);
  else if (action === 'complete' && filename) {
    if ((await stat(filename)).size > MAX_RECIPE_BYTES) throw Error('结果文件超过 64 KiB。');
    result = await queue.complete(id, JSON.parse(await readFile(filename, 'utf8')));
  } else throw Error('用法：node recipe-cli.mjs pending | show <请求ID> | complete <请求ID> <结果JSON路径>');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
