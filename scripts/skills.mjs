#!/usr/bin/env node
// Manage the skills in this repo. Run `npm run skills -- help` for usage.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINK_TARGET,
  MAX_NAME,
  SKILL_NAME_RE,
  exists,
  findSymlinks,
  hashSkillDir,
  licenseFile,
  loadSkills,
  parseSkillMd,
  readIntegrity,
  readLock,
  renderCatalog,
  repoPaths,
  sanitizeName,
  sourceLabel,
  upstreamByDir,
  validateRepo,
  writeIntegrity,
} from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const P = repoPaths(ROOT);
const TIMER = 'agent-skills-update';
// npm runs scripts from the repo root; INIT_CWD is where the user actually typed the command.
const CALLER_CWD = process.env.INIT_CWD ?? process.cwd();

class UserError extends Error {}
const fail = (message) => {
  throw new UserError(message);
};

const HELP = `Manage the skills in this repo.

Usage: npm run <script> -- [args]

  skill:add <source> <skill...>   Add skills from skills.sh or any git repo (auto-updated)
  skill:add <source> --list       Show the skills available in <source>
  skill:new <name> [--description "..."]
                                  Create your own skill in skills/<name>
  skill:import <folder|file.zip> [--force]
                                  Copy in a skill that is not in a git repo (not auto-updated)
  skill:remove <skill...>         Remove skills (upstream or local)
  skills:list                     List every skill and where it comes from
  skills:update [skill...]        Pull the latest version of upstream skills
  skills:validate                 Check every skill against the Agent Skills spec (runs in CI)
  skills:catalog                  Regenerate CATALOG.md
  skills:package [skill...]       Build dist/<skill>.zip for Claude.ai and ChatGPT uploads
  skills:install [--agent a b] [--skill s t] [--local]
                                  Install this repo's skills on this machine for your agents
  skills:autoupdate enable|disable|status|run
                                  Daily 'skills update -g' on this machine (Linux, systemd)

<source> examples: mattpocock/skills, mattpocock/skills@grill-me,
https://github.com/owner/repo, https://gitlab.com/owner/repo, git@host:owner/repo.git`;

// Runs the pinned skills CLI from node_modules (same CLI as `npx skills`, version kept current by Renovate).
async function runSkillsCli(args, cwd = P.upstream) {
  if (!(await exists(P.cli))) fail('The skills CLI is not installed. Run `npm ci` first.');
  const result = spawnSync(process.execPath, [P.cli, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function ensureWorkspace() {
  await mkdir(P.skills, { recursive: true });
  await mkdir(dirname(P.link), { recursive: true });
  if (!(await exists(P.link))) await symlink(LINK_TARGET, P.link, 'dir');
  const problems = (await validateRepo(ROOT)).errors.filter((error) => error.startsWith('upstream/.agents/skills'));
  if (problems.length) fail(problems.join('\n'));
}

async function writeCatalog() {
  await writeFile(P.catalog, renderCatalog(await loadSkills(ROOT)));
}

// Records the installed state of upstream skills so validation can spot hand edits.
async function recordIntegrity(dirs) {
  const integrity = await readIntegrity(ROOT);
  for (const dir of dirs) {
    if (await exists(join(P.skills, dir))) integrity[dir] = await hashSkillDir(join(P.skills, dir));
    else delete integrity[dir];
  }
  await writeIntegrity(ROOT, integrity);
}

function splitFlags(argv, known) {
  // Collects values after each known flag (e.g. --agent a b) and returns the rest as positionals.
  const flags = Object.fromEntries(Object.keys(known).map((flag) => [flag, known[flag] ? [] : false]));
  const aliases = { '-a': '--agent', '-s': '--skill', '-l': '--list', '-f': '--force', '-d': '--description' };
  const positionals = [];
  let current = null;
  for (const raw of argv) {
    const arg = aliases[raw] ?? raw;
    if (arg in known) {
      if (known[arg]) current = arg;
      else {
        flags[arg] = true;
        current = null;
      }
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${raw}`);
    } else if (current) {
      flags[current].push(arg);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

async function cmdAdd(argv) {
  const { flags, positionals } = splitFlags(argv, { '--list': false });
  let [source, ...names] = positionals;
  if (!source) fail('Usage: npm run skill:add -- <source> <skill...>   (or <source> --list)');
  // The CLI runs inside upstream/, so resolve relative local paths from where npm was called.
  if (/^\.{1,2}([/\\]|$)/.test(source)) source = resolve(CALLER_CWD, source);
  await ensureWorkspace();
  if (flags['--list']) {
    process.exitCode = await runSkillsCli(['add', source, '--list']);
    return;
  }
  const shorthand = source.match(/^([\w.-]+\/[\w.-]+)@([\w.-]+)$/);
  if (shorthand && names.length === 0) [source, names] = [shorthand[1], [shorthand[2]]];
  if (names.length === 0) fail(`Name the skills to add, e.g. npm run skill:add -- ${source} <skill>\nSee what is available: npm run skill:add -- ${source} --list`);
  // Wildcards would let the CLI overwrite local skills we never got to check.
  const wild = names.filter((name) => /[*?[\]]/.test(name));
  if (wild.length) fail(`Name each skill explicitly (no wildcards: ${wild.join(', ')}). See the list with: npm run skill:add -- ${source} --list`);

  const upstream = upstreamByDir(await readLock(ROOT));
  for (const name of names) {
    const dir = sanitizeName(name);
    const tracked = upstream.get(dir);
    if (!tracked && (await exists(join(P.skills, dir)))) {
      fail(`skills/${dir} is one of your local skills. Remove or rename it before adding "${name}" from ${source}.`);
    }
  }

  // --agent codex targets only the universal .agents/skills folder, i.e. skills/ through the symlink.
  const status = await runSkillsCli(['add', source, '--skill', ...names, '--agent', 'codex', '--yes']);
  if (status !== 0) fail(`skills add failed (exit ${status}); nothing else was changed`);

  const after = upstreamByDir(await readLock(ROOT));
  const added = names.map((name) => sanitizeName(name)).filter((dir) => after.has(dir));
  const missing = names.filter((name) => !after.has(sanitizeName(name)));
  await recordIntegrity(added);
  await writeCatalog();
  for (const dir of added) await saveLicense(after.get(dir).entry);
  if (missing.length) fail(`Not found in ${source}: ${missing.join(', ')}. List them with: npm run skill:add -- ${source} --list`);
  console.log(`\n✓ Added ${names.join(', ')}. Review with \`git diff\`, then commit.`);
}

// MIT and most other licenses require their text to ship with every copy, so keep one per upstream repo.
async function saveLicense(entry) {
  const file = licenseFile(ROOT, entry);
  const source = entry.sourceUrl || entry.source;
  if (file === null) return console.warn(`! Save the license of ${source} in licenses/ by hand.`);
  if (await exists(file)) return;
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${entry.source}/license`, {
      headers: { accept: 'application/vnd.github.raw+json', 'user-agent': 'agent-skills' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return console.warn(`! Could not fetch the license of ${source} (${error.message}); save it in licenses/ by hand.`);
  }
  if (response.status === 404) {
    return console.warn(`! ${source} has no repo-wide license. Check each skill ships its own before you push.`);
  }
  if (!response.ok) return console.warn(`! Could not fetch the license of ${source} (HTTP ${response.status}); save it in licenses/ by hand.`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await response.text());
  console.log(`✓ Saved licenses/${basename(file)}`);
}

// Drops the saved license of a removed skill's repo once no remaining skill comes from that repo.
async function pruneLicenses(removedEntries) {
  const stillUsed = new Set(Object.values((await readLock(ROOT)).skills).map((entry) => licenseFile(ROOT, entry)));
  for (const entry of removedEntries) {
    const file = licenseFile(ROOT, entry);
    if (file && !stillUsed.has(file)) await rm(file, { force: true });
  }
}

async function cmdRemove(names) {
  if (names.length === 0) fail('Usage: npm run skill:remove -- <skill...>');
  const upstream = upstreamByDir(await readLock(ROOT));
  const upstreamKeys = [];
  const removedEntries = [];
  const localDirs = [];
  for (const name of names) {
    const tracked = upstream.get(name) ?? upstream.get(sanitizeName(name));
    if (tracked) {
      upstreamKeys.push(tracked.key);
      removedEntries.push(tracked.entry);
    } else if (SKILL_NAME_RE.test(name) && (await exists(join(P.skills, name)))) {
      localDirs.push(name);
    } else {
      fail(`No skill named "${name}" in skills/`);
    }
  }

  if (upstreamKeys.length) {
    await ensureWorkspace();
    // Always pass names: `skills remove` without names would also see local skills through the symlink.
    const status = await runSkillsCli(['remove', ...upstreamKeys, '--yes']);
    if (status !== 0) fail(`skills remove failed (exit ${status})`);
    const left = upstreamByDir(await readLock(ROOT));
    for (const key of upstreamKeys) {
      if (left.has(sanitizeName(key))) fail(`${key} is still listed in upstream/skills-lock.json`);
      await rm(join(P.skills, sanitizeName(key)), { recursive: true, force: true });
    }
    await recordIntegrity(upstreamKeys.map((key) => sanitizeName(key)));
    await pruneLicenses(removedEntries);
  }
  for (const dir of localDirs) await rm(join(P.skills, dir), { recursive: true, force: true });

  await writeCatalog();
  console.log(`✓ Removed ${[...upstreamKeys, ...localDirs].join(', ')}.`);
}

async function cmdUpdate(names) {
  const upstream = upstreamByDir(await readLock(ROOT));
  if (upstream.size === 0) {
    console.log('No upstream skills to update.');
    await writeCatalog();
    return;
  }
  const keys = names.map((name) => {
    const tracked = upstream.get(name) ?? upstream.get(sanitizeName(name));
    if (!tracked) fail(`"${name}" is not an upstream skill (see upstream/skills-lock.json)`);
    return tracked.key;
  });
  await ensureWorkspace();
  const status = await runSkillsCli(['update', '--project', '--yes', ...keys]);
  if (status !== 0) fail(`skills update failed (exit ${status})`);

  // `skills update` reinstalled these folders, so their installed state becomes the new baseline.
  const lockDirs = [...upstreamByDir(await readLock(ROOT)).keys()];
  const previous = await readIntegrity(ROOT);
  const refreshed = new Set(keys.length ? keys.map((key) => sanitizeName(key)) : lockDirs);
  const next = {};
  for (const dir of lockDirs) {
    if (!(await exists(join(P.skills, dir)))) continue;
    next[dir] = refreshed.has(dir) || !previous[dir] ? await hashSkillDir(join(P.skills, dir)) : previous[dir];
  }
  await writeIntegrity(ROOT, next);
  await writeCatalog();

  const broken = (await validateRepo(ROOT)).errors.filter((error) => error.includes('skills-lock.json'));
  if (broken.length) fail(broken.join('\n'));
  console.log('\n✓ Upstream skills are up to date. Review changes with `git diff -- skills`.');
}

async function cmdNew(argv) {
  const { flags, positionals } = splitFlags(argv, { '--description': true });
  const [name] = positionals;
  if (!name || positionals.length > 1) fail('Usage: npm run skill:new -- <name> [--description "What it does and when to use it"]');
  if (name.length > MAX_NAME || !SKILL_NAME_RE.test(name)) {
    fail(`"${name}" is not a valid skill name: use lowercase letters, digits and single hyphens (max ${MAX_NAME}).`);
  }
  const dir = join(P.skills, name);
  if (await exists(dir)) fail(`skills/${name} already exists`);

  const description = flags['--description'].join(' ').trim() ||
    'TODO: say what this skill does and when to use it, with the words a user would say. Max 1024 characters.';
  const title = name.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${title}

## When to use

- TODO: the situations and phrases that should trigger this skill

## Instructions

1. TODO: the steps the agent should follow

## Examples

TODO: an example request and the result you expect

<!-- Keep this file under 500 lines. Put long reference material in references/, scripts in scripts/, templates in assets/. -->
`,
  );
  await writeCatalog();
  console.log(`✓ Created skills/${name}/SKILL.md. Fill in the TODOs, then run npm run skills:validate.`);
}

async function findSkillDirs(root) {
  if (await exists(join(root, 'SKILL.md'))) return [root];
  const found = [];
  const walk = async (dir, depth) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '__MACOSX' || entry.name === 'node_modules') continue;
      const child = join(dir, entry.name);
      if (await exists(join(child, 'SKILL.md'))) found.push(child);
      else if (depth < 3) await walk(child, depth + 1);
    }
  };
  await walk(root, 1);
  return found;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function cmdImport(argv) {
  const { flags, positionals } = splitFlags(argv, { '--force': false });
  const [input] = positionals;
  if (!input || positionals.length > 1) fail('Usage: npm run skill:import -- <folder|file.zip> [--force]');
  const source = resolve(CALLER_CWD, input);
  if (!(await exists(source))) fail(`${source} does not exist`);
  if (isInside(source, P.skills)) fail('That folder is already inside skills/; nothing to import');

  let root = source;
  let tempDir = null;
  let staging = null;
  try {
    if ((await stat(source)).isFile()) {
      if (!source.toLowerCase().endsWith('.zip')) fail('Import a skill folder or a .zip file');
      tempDir = await mkdtemp(join(tmpdir(), 'skill-import-'));
      const unzip = spawnSync('unzip', ['-q', source, '-d', tempDir], { stdio: 'inherit' });
      if (unzip.error?.code === 'ENOENT') fail('`unzip` is not installed');
      if (unzip.status !== 0) fail(`unzip failed for ${source}`);
      root = tempDir;
    }
    const dirs = await findSkillDirs(root);
    if (dirs.length === 0) fail(`No SKILL.md found in ${input}`);

    const upstream = upstreamByDir(await readLock(ROOT));
    const plan = [];
    for (const dir of dirs) {
      const where = relative(root, dir) || basename(dir);
      const parsed = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8'));
      if (parsed.error) fail(`${where}/SKILL.md: ${parsed.error}`);
      const name = parsed.data.name;
      if (typeof name !== 'string' || name.length > MAX_NAME || !SKILL_NAME_RE.test(name)) {
        fail(`${where}/SKILL.md: name "${name}" is not a valid skill name; fix it in the source first`);
      }
      if (plan.some((item) => item.name === name)) fail(`Two skills in ${input} are both named "${name}"`);
      if (upstream.has(name)) fail(`"${name}" is an upstream skill; remove it first if you want a local copy`);
      if ((await exists(join(P.skills, name))) && !flags['--force']) fail(`skills/${name} already exists (use --force to replace it)`);
      const links = await findSymlinks(dir);
      if (links.length) fail(`${where} contains symlinks (${links.join(', ')}); replace them with real files first`);
      plan.push({ dir, name });
    }

    // Copy everything into a hidden staging folder first, so a failure never leaves a half-replaced skill.
    await mkdir(P.skills, { recursive: true });
    staging = await mkdtemp(join(P.skills, '.import-'));
    const skip = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', 'Thumbs.db']);
    for (const { dir, name } of plan) {
      await cp(dir, join(staging, name), { recursive: true, filter: (path) => !skip.has(basename(path)) });
    }
    for (const { name } of plan) {
      await rm(join(P.skills, name), { recursive: true, force: true });
      await rename(join(staging, name), join(P.skills, name));
    }
    await writeCatalog();
    console.log(`✓ Imported ${plan.map((item) => item.name).join(', ')} as local skill(s); they are not auto-updated.`);
    console.log('  If a skill lives in a git repo, use skill:add instead so it stays up to date.');
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function cmdList() {
  const skills = await loadSkills(ROOT);
  if (skills.length === 0) return console.log('No skills yet. Add one with: npm run skill:add -- <source> <skill>');
  const width = Math.max(...skills.map((skill) => skill.dirName.length));
  for (const skill of skills) {
    console.log(`${skill.dirName.padEnd(width)}  ${skill.kind.padEnd(8)}  ${sourceLabel(skill).text}`);
  }
}

async function cmdValidate() {
  const { errors, warnings, skills = [] } = await validateRepo(ROOT);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length) {
    process.exitCode = 1;
    console.error(`\n✗ ${errors.length} error(s)`);
  } else {
    console.log(`✓ ${skills.length} skill(s) valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  }
}

async function cmdCatalog() {
  await writeCatalog();
  console.log('✓ CATALOG.md updated');
}

async function cmdPackage(names) {
  const skills = await loadSkills(ROOT);
  const selected = names.length ? names.map((name) => skills.find((skill) => skill.dirName === name) ?? fail(`No skill named "${name}"`)) : skills;
  await mkdir(P.dist, { recursive: true });
  for (const skill of selected) {
    // zip follows symlinks, which could pack files from anywhere on this machine into an upload.
    const links = skill.isSymlink ? ['(the folder itself)'] : await findSymlinks(skill.dir);
    if (links.length) fail(`skills/${skill.dirName} contains symlinks (${links.join(', ')}); not packaging it`);
    const zipPath = join(P.dist, `${skill.dirName}.zip`);
    await rm(zipPath, { force: true });
    // The zip holds the skill folder itself (skill-name/SKILL.md), the layout Claude.ai and ChatGPT expect.
    const zip = spawnSync('zip', ['-r', '-q', '-X', zipPath, skill.dirName, '-x', '*.DS_Store'], { cwd: P.skills, stdio: 'inherit' });
    if (zip.error?.code === 'ENOENT') fail('`zip` is not installed');
    if (zip.status !== 0) fail(`zip failed for ${skill.dirName}`);
    const { size } = await stat(zipPath);
    if (size > 50 * 1024 * 1024) console.warn(`warning: ${skill.dirName}.zip is over the 50 MB upload limit`);
    console.log(`✓ dist/${skill.dirName}.zip`);
  }
}

async function packageJson() {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
}

async function repoSlug() {
  const pkg = await packageJson();
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  const match = repository.match(/(?:github:|github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  if (!match) fail('Set "repository" in package.json to github:<owner>/<repo>');
  return match[1];
}

async function cmdInstall(argv) {
  const { flags, positionals } = splitFlags(argv, { '--agent': true, '--skill': true, '--local': false });
  if (positionals.length) fail(`Unexpected argument: ${positionals[0]}`);
  // From GitHub by default, so `npx skills update -g` later pulls new versions of this repo.
  const source = flags['--local'] ? ROOT : await repoSlug();
  const args = ['add', source, '--global', '--yes', '--skill', ...(flags['--skill'].length ? flags['--skill'] : ['*'])];
  if (flags['--agent'].length) args.push('--agent', ...flags['--agent']);
  const status = await runSkillsCli(args, homedir());
  if (status !== 0) fail(`skills add failed (exit ${status})`);
  if (flags['--local']) console.log('Note: --local installs are a snapshot; `skills update -g` will not refresh them.');
}

async function cmdAutoupdate([action = 'status']) {
  if (process.platform !== 'linux' || spawnSync('systemctl', ['--user', '--version']).status !== 0) {
    fail('Automatic setup needs Linux with systemd. Elsewhere, schedule `npx --yes skills update --global --yes` daily (launchd, Task Scheduler).');
  }
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const service = join(unitDir, `${TIMER}.service`);
  const timer = join(unitDir, `${TIMER}.timer`);
  const systemctl = (...args) => spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit' }).status ?? 1;

  if (action === 'enable') {
    // Pin the CLI to the version this repo tests (Renovate keeps package.json current; re-run enable after pulling).
    const version = (await packageJson()).devDependencies?.skills;
    if (!version) fail('package.json has no pinned "skills" devDependency');
    const npx = spawnSync('sh', ['-c', 'command -v npx'], { encoding: 'utf8' }).stdout.trim();
    if (!npx) fail('npx not found on PATH');
    const path = [...new Set([dirname(npx), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(':');
    await mkdir(unitDir, { recursive: true });
    await writeFile(
      service,
      `[Unit]
Description=Update globally installed agent skills (skills update -g)

[Service]
Type=oneshot
Environment=PATH=${path}
Environment=NO_COLOR=1
Environment=DISABLE_TELEMETRY=1
ExecStart=${npx} --yes skills@${version} update --global --yes
`,
    );
    await writeFile(
      timer,
      `[Unit]
Description=Daily update of agent skills

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
    );
    if (systemctl('daemon-reload') !== 0 || systemctl('enable', '--now', `${TIMER}.timer`) !== 0) fail('systemctl failed');
    console.log(`✓ Daily update enabled with skills@${version}. Logs: journalctl --user -u ${TIMER}.service`);
  } else if (action === 'disable') {
    systemctl('disable', '--now', `${TIMER}.timer`);
    await rm(service, { force: true });
    await rm(timer, { force: true });
    systemctl('daemon-reload');
    console.log('✓ Daily update disabled');
  } else if (action === 'run') {
    if (!(await exists(service))) fail('Not enabled. Run: npm run skills:autoupdate -- enable');
    process.exitCode = systemctl('start', `${TIMER}.service`);
    console.log(`Done. Logs: journalctl --user -u ${TIMER}.service -n 50`);
  } else if (action === 'status') {
    if (!(await exists(timer))) return console.log('Daily update is not enabled. Run: npm run skills:autoupdate -- enable');
    systemctl('list-timers', `${TIMER}.timer`, '--no-pager');
    spawnSync('journalctl', ['--user', '-u', `${TIMER}.service`, '-n', '15', '--no-pager'], { stdio: 'inherit' });
  } else {
    fail('Usage: npm run skills:autoupdate -- enable|disable|status|run');
  }
}

const commands = {
  add: cmdAdd,
  remove: cmdRemove,
  update: cmdUpdate,
  new: cmdNew,
  import: cmdImport,
  list: cmdList,
  validate: cmdValidate,
  catalog: cmdCatalog,
  package: cmdPackage,
  install: cmdInstall,
  autoupdate: cmdAutoupdate,
};

const [command, ...args] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log(HELP);
} else if (!commands[command]) {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
} else {
  try {
    await commands[command](args);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
