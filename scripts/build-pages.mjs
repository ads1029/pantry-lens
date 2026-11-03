import {readFile, writeFile, mkdir, rm, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export const publicFiles = ['style.css', 'src/recipe-app.js', 'src/recipes.js', 'src/ingredient-presets.js', 'src/static-recipes.js', 'src/static-shell.js', 'recipe-catalog-expanded.mjs', 'recipe-ingredients.mjs', 'recipe-error.mjs'];

export async function buildPages(output = path.join(root, 'dist')) {
  let html = await readFile(path.join(root, 'index.html'), 'utf8');
  html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" data-recipe-mode="static">')
    .replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./')
    .replace('本机运行 · AI 联网', '浏览器内匹配 · 不调用 AI')
    .replace('id="pantry-tab"', 'id="pantry-tab" hidden disabled')
    .replace('<nav class="view-switch"', '<nav class="view-switch" hidden')
    .replace('<option value="6">6 人</option>', '')
    .replace('清淡、少油、适合带饭', '少油、素食、纯素')
    .replace('AI 优先从家常菜谱库挑选三道，匹配不足时现场生成。食材与偏好会发送给模型，使用现有 Codex 账号额度。', '在线版从192道家常菜中本地匹配三道，不调用AI、不上传食材。支持1–4人和简单条件筛选；不会理解复杂口味指令。匹配不足时会提示，不会现场生成。')
    .replace('<script type="module" src="./src/app.js"></script>', '<script type="module" src="./src/static-shell.js"></script>');
  const start = html.indexOf('<div id="pantry-view" hidden>'), end = html.indexOf('</div><footer>', start);
  if (start < 0 || end < 0 || !html.includes('data-recipe-mode="static"')) throw Error('静态页面模板不匹配，停止发布。');
  html = html.slice(0, start) + '<div id="pantry-view" hidden></div>' + html.slice(end + 6);
  // Publish an explicit allowlist. Never copy the project or runtime directory wholesale.
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  await writeFile(path.join(output, 'index.html'), html);
  await writeFile(path.join(output, '.nojekyll'), '');
  for (const filename of publicFiles) {
    const target = path.join(output, filename);
    await mkdir(path.dirname(target), {recursive: true});
    await copyFile(path.join(root, filename), target);
  }
  return ['index.html', '.nojekyll', ...publicFiles];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await buildPages();
  console.log(`GitHub Pages: built ${files.length} public files into dist/ (no API or runtime data)`);
}
