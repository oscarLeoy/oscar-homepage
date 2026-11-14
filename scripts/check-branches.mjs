// 收尾检查：分支和任务文件不靠人记着收。
// 分支：仓库里除默认分支外，只留 STATUS.md 或 tasks/ 里点了名的分支。
//   点了名的分支            → 不动
//   没点名、已全部合进主线   → 直接删掉（内容都在主线里，删了不丢东西）
//   没点名、还有没合并的提交 → 报出来，退出码 1（没人认领：要么写进 STATUS，要么删）
// 任务文件：tasks/ 里 14 天没人动过的文件 → 报出来，退出码 1（还在做就更新进度，做完了就删）
// 用法：node scripts/check-branches.mjs            推送主线时由 workflow 跑，会真的删
//       node scripts/check-branches.mjs --dry-run  只列不删，本地随时可跑
// 默认分支不叫 main 的仓库：DEFAULT_BRANCH=<名字> node scripts/check-branches.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const main = process.env.DEFAULT_BRANCH || 'main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (...args) => { try { git(...args); return true; } catch { return false; } };

// 把所有远端分支取到本地再比，不加 --prune，不动任何本地分支。
git('fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*');
if (git('rev-parse', '--is-shallow-repository') === 'true') {
  console.log('这是浅克隆，判断不了分支有没有合并，本次跳过；推送后由 workflow 在完整克隆里检查。');
  process.exit(dryRun ? 0 : 1);
}

const files = dir => !existsSync(dir) ? [] : readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const claimed = ['STATUS.md', ...files('tasks')].filter(existsSync).map(file => readFileSync(file, 'utf8')).join('\n');

// 整个分支名都出现才算点名：写了 codex/ui-2 不等于认领了 codex/ui。
const isClaimed = name => {
  for (let at = claimed.indexOf(name); at !== -1; at = claimed.indexOf(name, at + 1)) {
    const before = claimed.slice(0, at), after = claimed.slice(at + name.length);
    if (!/[\p{L}\p{M}\p{N}\p{Pc}./-]$/u.test(before) && !/^[\p{L}\p{M}\p{N}\p{Pc}/-]/u.test(after) && !/^\.[\p{L}\p{M}\p{N}\p{Pc}]/u.test(after)) return true;
  }
  return false;
};

const remote = git('ls-remote', '--heads', 'origin').split('\n').filter(Boolean)
  .map(line => { const [sha, ref] = line.split('\t'); return [ref.replace('refs/heads/', ''), sha]; });
const mainSha = remote.find(([name]) => name === main)?.[1];
if (!mainSha || git('rev-parse', `origin/${main}`) !== mainSha || (!dryRun && git('rev-parse', 'HEAD') !== mainSha)) {
  console.error('主分支已变化或当前检出不是最新主分支，请重新检查。');
  process.exit(1);
}
const branches = remote.filter(([name]) => name !== main);

const deleted = [], unclaimed = [], stuck = [];
for (const [name, sha] of branches) {
  if (isClaimed(name)) continue;
  if (!ok('cat-file', '-e', `${sha}^{commit}`) || !ok('rev-parse', '--verify', `refs/remotes/origin/${name}`) || git('rev-parse', `origin/${name}`) !== sha) {
    stuck.push(`${name}（分支已变化，请重新检查）`);
  } else if (ok('merge-base', '--is-ancestor', sha, mainSha)) {
    if (dryRun) deleted.push(name);
    else if (git('ls-remote', '--heads', 'origin', `refs/heads/${main}`).split('\t')[0] !== mainSha) {
      stuck.push(`${name}（主分支已变化，请重新检查）`);
      break;
    } else if (ok('push', '--quiet', `--force-with-lease=refs/heads/${name}:${sha}`, 'origin', `:refs/heads/${name}`)) deleted.push(name);
    else stuck.push(`${name}（分支已变化或无删除权限）`);
  } else {
    unclaimed.push(`${name}（最后提交 ${git('log', '-1', '--format=%cs', sha)}）`);
  }
}

// 任务文件做完要删。14 天没有任何提交动过它，多半是做完忘了删，或者卡住了没人知道。
const STALE_DAYS = 14;
const stale = files('tasks').filter(file => file.endsWith('.md')).flatMap(file => {
  const last = Number(git('log', '-1', '--format=%ct', '--', file));
  const days = last ? Math.floor((Date.now() / 1000 - last) / 86400) : 0;
  return days >= STALE_DAYS ? [`${file}（${days} 天没动）`] : [];
});

const list = items => items.map(item => `  ${item}`).join('\n');
if (deleted.length) console.log(`${dryRun ? '已合并、会被删掉' : '已合并、已删掉'}的分支：\n${list(deleted)}`);
if (stuck.length) console.log(`未能检查或删除：\n${list(stuck)}`);
if (unclaimed.length) console.log(`没人认领的分支（还在做就把分支名写进 STATUS.md 那一行，不要了就删）：\n${list(unclaimed)}`);
if (stale.length) console.log(`放了很久的任务文件（还在做就更新进度一节，做完或不做了就删掉）：\n${list(stale)}`);
if (!deleted.length && !stuck.length && !unclaimed.length) console.log(`OK  除 ${main} 外只有点了名的分支（${branches.length} 个）`);
process.exit(unclaimed.length || stuck.length || stale.length ? 1 : 0);
