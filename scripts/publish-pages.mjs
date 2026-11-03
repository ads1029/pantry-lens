import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPages} from './build-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
// Deploy only the explicit static build. Preserve the current branch and staged files.
const gitDir = git(['rev-parse', '--absolute-git-dir']);
const remote = git(['remote', 'get-url', 'origin']);
if (!/^(https:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+(?:\.git)?$/.test(remote)) throw Error('origin必须是明确的GitHub仓库地址。');
const previous = git(['ls-remote', '--heads', 'origin', 'refs/heads/gh-pages']).split(/\s/)[0];
if (previous) git(['fetch', '--quiet', 'origin', 'refs/heads/gh-pages']);
const output = path.join(root, 'dist');
await buildPages(output);
const temporary = await mkdtemp(path.join(tmpdir(), 'pantry-pages-index-'));
try {
  const environment = {...process.env, GIT_INDEX_FILE: path.join(temporary, 'index')};
  const stage = args => execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${output}`, ...args], {cwd: output, env: environment, encoding: 'utf8'}).trim();
  stage(['read-tree', '--empty']);
  stage(['add', '--all', '--force', '.']);
  const tree = stage(['write-tree']);
  if (previous && git(['rev-parse', `${previous}^{tree}`]) === tree) console.log('GitHub Pages: static files unchanged; no push needed.');
  else {
    const commit = git(['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', 'Deploy Pantry Lens static site']);
    git(['push', 'origin', `${commit}:refs/heads/gh-pages`]);
    console.log(`GitHub Pages: published static commit ${commit}`);
  }
} finally { await rm(temporary, {recursive: true, force: true}); }
