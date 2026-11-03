import {mkdir, readFile, writeFile, rename, readdir, stat, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recipeInput, validRequestId, validateRecipeResult, RECIPE_VERSION} from './src/recipes.js';
import {RecipeError} from './recipe-error.mjs';
export {RecipeError} from './recipe-error.mjs';

export const recipeDirectory = fileURLToPath(new URL('./runtime/recipes/', import.meta.url));
export const MAX_RECIPE_BYTES = 64 * 1024;
export function createRecipeQueue(directory = recipeDirectory) {
  const file = (kind, id) => {
    if (!validRequestId(id)) throw new RecipeError('请求编号格式错误。');
    return path.join(directory, kind, `${id}.json`);
  };
  async function read(kind, id) {
    const filename = file(kind, id);
    if ((await stat(filename)).size > MAX_RECIPE_BYTES) throw new RecipeError('JSON 文件超过 64 KiB。', 422);
    return JSON.parse(await readFile(filename, 'utf8'));
  }
  async function write(kind, id, value) {
    const filename = file(kind, id);
    await mkdir(path.dirname(filename), {recursive: true, mode: 0o700});
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(temporary, filename);
  }
  async function request(id) {
    try { return await read('requests', id); }
    catch (error) { if (error.code === 'ENOENT') throw new RecipeError('找不到这个食谱请求。', 404); throw error; }
  }
  return {
    async create(input) {
      let normalized;
      try { normalized = recipeInput(input); } catch (error) { throw new RecipeError(error.message); }
      const value = {schemaVersion: RECIPE_VERSION, requestId: randomUUID(), createdAt: new Date().toISOString(), ...normalized};
      await write('requests', value.requestId, value);
      return value;
    },
    request,
    async clearResult(id) { await rm(file('results', id), {force: true}); },
    async saveMetrics(id, value) { await write('metrics', id, value); },
    async metrics(id) {
      let value;
      try { value = await read('metrics', id); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try { const browser = await read('display-metrics', id); if (browser.attemptId === value.attemptId) value.browser = browser; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return value;
    },
    async displayed(id, input) {
      const metrics = await this.metrics(id);
      if (!input || !metrics || input.attemptId !== metrics.attemptId) throw new RecipeError('该次生成已更新，请重新读取结果。', 409);
      const ready = await this.get(id);
      if (ready.status !== 'ready' || ready.result.status !== 'completed') throw new RecipeError('食谱尚未完成，不能记录显示成功。', 409);
      const browser = {attemptId: metrics.attemptId, recordedAt: new Date().toISOString()};
      for (const key of ['totalMs', 'acceptedMs', 'afterAcceptedMs', 'renderMs']) {
        if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 600000) throw new RecipeError('页面计时须在 0–600000 毫秒内。');
        browser[key] = Math.round(input[key] * 100) / 100;
      }
      if (browser.totalMs < browser.acceptedMs || Math.abs(browser.totalMs - browser.acceptedMs - browser.afterAcceptedMs) > 5) throw new RecipeError('页面计时不一致。');
      // A reload must never replace the measured click-to-display time with a cache read.
      if (!metrics.browser) await write('display-metrics', id, browser);
      return this.metrics(id);
    },
    async job(id) {
      try { return await read('jobs', id); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async setJob(id, status, error = '') {
      const job = {requestId: id, status, updatedAt: new Date().toISOString(), error};
      await write('jobs', id, job);
      return job;
    },
    async get(id) {
      const input = await request(id);
      let value;
      try { value = await read('results', id); }
      catch (error) {
        if (error.code === 'ENOENT') return {status: 'pending', request: input, job: await this.job(id), metrics: await this.metrics(id)};
        throw new RecipeError('结果文件损坏或超限，请让 Codex 检查并重新写入。', 422);
      }
      try { return {status: 'ready', request: input, result: validateRecipeResult(value, input), metrics: await this.metrics(id)}; }
      catch (error) { throw new RecipeError(`结果校验失败：${error.message}`, 422); }
    },
    async complete(id, result) {
      const input = await request(id), checked = validateRecipeResult(result, input);
      if (Buffer.byteLength(JSON.stringify(checked)) > MAX_RECIPE_BYTES) throw new RecipeError('结果超过 64 KiB。');
      await write('results', id, checked);
      return checked;
    },
    async pending() {
      let entries;
      try { entries = await readdir(path.join(directory, 'requests')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const pending = [];
      for (const entry of entries) {
        const id = entry.replace(/\.json$/, '');
        if (!entry.endsWith('.json') || !validRequestId(id)) continue;
        // Invalid results remain actionable, rather than disappearing from the inbox.
        try { if ((await this.get(id)).status === 'pending') pending.push({requestId: id, status: 'pending'}); }
        catch { pending.push({requestId: id, status: 'invalid'}); }
      }
      return pending;
    },
  };
}
