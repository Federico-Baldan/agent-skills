// Shared helpers for scripts/skills.mjs. Every function takes the repo root so the tests can run on a temp repo.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Limits from the Agent Skills specification: https://agentskills.io/specification
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;
export const MAX_LINES = 500;

// upstream/.agents/skills must point here so the skills CLI writes straight into skills/.
export const LINK_TARGET = '../../skills';

export function repoPaths(root) {
  return {
    root,
    skills: join(root, 'skills'),
    upstream: join(root, 'upstream'),
    lock: join(root, 'upstream', 'skills-lock.json'),
    integrity: join(root, 'upstream', 'integrity.json'),
    link: join(root, 'upstream', '.agents', 'skills'),
    catalog: join(root, 'CATALOG.md'),
    dist: join(root, 'dist'),
    cli: join(root, 'node_modules', 'skills', 'bin', 'cli.mjs'),
    licenses: join(root, 'licenses'),
  };
}

// licenses/<owner>__<repo>.txt keeps each upstream repo's license next to the copies we republish.
export function licenseFile(root, entry) {
  if (entry.sourceType !== 'github' || !/^[A-Za-z0-9-]+\/[\w.-]+$/.test(entry.source ?? '')) return null;
  return join(repoPaths(root).licenses, `${entry.source.replace('/', '__')}.txt`);
}

// Same folder naming as the skills CLI, so lock entries map to the right skills/<dir>.
export function sanitizeName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .substring(0, 255) || 'unnamed-skill'
  );
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readLock(root) {
  let text;
  try {
    text = await readFile(repoPaths(root).lock, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, skills: {} };
    throw error;
  }
  const lock = JSON.parse(text);
  return { version: lock.version ?? 1, skills: lock.skills ?? {} };
}

// Map of skills/<dir> -> { key, entry } for every skill tracked in upstream/skills-lock.json.
export function upstreamByDir(lock) {
  const map = new Map();
  for (const [key, entry] of Object.entries(lock.skills)) map.set(sanitizeName(key), { key, entry });
  return map;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMd(text) {
  const match = text.replace(/^\uFEFF/, '').match(FRONTMATTER_RE);
  if (!match) return { error: 'missing YAML frontmatter (a --- block with name and description) at the top of SKILL.md' };
  let data;
  try {
    data = parseYaml(match[1]);
  } catch (error) {
    return { error: `invalid YAML frontmatter: ${error.message.split('\n')[0]}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'frontmatter must be a YAML mapping' };
  return { data };
}

export function frontmatterIssues(data, dirName) {
  const issues = [];
  const { name, description, compatibility, metadata } = data;

  if (typeof name !== 'string' || name === '') {
    issues.push('`name` is required and must be a string');
  } else {
    if (name.length > MAX_NAME) issues.push(`\`name\` is longer than ${MAX_NAME} characters`);
    if (!SKILL_NAME_RE.test(name)) {
      issues.push('`name` may only use lowercase letters, digits and single hyphens, and cannot start or end with a hyphen');
    }
    if (name !== dirName) issues.push(`\`name\` ("${name}") must match its folder name ("${dirName}")`);
  }

  if (typeof description !== 'string' || description.trim() === '') {
    issues.push('`description` is required and must be a string');
  } else {
    if (description.length > MAX_DESCRIPTION) issues.push(`\`description\` is longer than ${MAX_DESCRIPTION} characters`);
    if (/^\s*TODO\b/i.test(description)) issues.push('`description` is still the TODO placeholder');
  }

  if (
    compatibility !== undefined &&
    (typeof compatibility !== 'string' || compatibility === '' || compatibility.length > MAX_COMPATIBILITY)
  ) {
    issues.push(`\`compatibility\` must be a string of 1-${MAX_COMPATIBILITY} characters`);
  }

  if (
    metadata !== undefined &&
    (metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.values(metadata).some((value) => typeof value !== 'string'))
  ) {
    issues.push('`metadata` must be a map of string keys to string values');
  }

  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') {
    issues.push('`allowed-tools` must be a space-separated string');
  }

  return issues;
}

// OS clutter that never belongs to a skill and must not break the integrity check.
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// SHA-256 over every file of an installed skill folder (path + bytes, sorted by path).
// We hash the folder as installed instead of trusting the lock's `computedHash`: the skills CLI hashes the
// *source* folder, but drops files like metadata.json and __pycache__ and dereferences symlinks when copying.
export async function hashSkillDir(skillDir) {
  const files = [];
  await walkFiles(skillDir, skillDir, files);
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(`${file.relativePath}\0`);
    hash.update(await readFile(file.fullPath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function walkFiles(baseDir, currentDir, results) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '.git') await walkFiles(baseDir, fullPath, results);
    } else if (!JUNK_FILES.has(entry.name)) {
      results.push({ relativePath: relative(baseDir, fullPath).split('\\').join('/'), fullPath, isSymlink: entry.isSymbolicLink() });
    }
  }
}

// Symlinks inside a skill can point anywhere on disk (and get followed when zipping), so skills may not contain any.
export async function findSymlinks(skillDir) {
  const files = [];
  await walkFiles(skillDir, skillDir, files);
  return files.filter((file) => file.isSymlink).map((file) => file.relativePath);
}

// upstream/integrity.json: skills/<dir> -> hashSkillDir() of the folder exactly as the skills CLI installed it.
export async function readIntegrity(root) {
  try {
    return JSON.parse(await readFile(repoPaths(root).integrity, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeIntegrity(root, integrity) {
  const sorted = Object.fromEntries(Object.entries(integrity).sort(([a], [b]) => (a < b ? -1 : 1)));
  await writeFile(repoPaths(root).integrity, `${JSON.stringify(sorted, null, 2)}\n`);
}

// Every folder in skills/, parsed, with where it comes from.
export async function loadSkills(root) {
  const paths = repoPaths(root);
  const upstream = upstreamByDir(await readLock(root));
  const skills = [];
  if (!(await exists(paths.skills))) return skills;

  const entries = (await readdir(paths.skills, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const dir = join(paths.skills, entry.name);
    const tracked = upstream.get(entry.name);
    const skill = {
      dirName: entry.name,
      dir,
      isSymlink: entry.isSymbolicLink(),
      kind: tracked ? 'upstream' : 'local',
      lockKey: tracked?.key,
      lockEntry: tracked?.entry,
      data: null,
      error: null,
      lineCount: 0,
    };
    let text;
    try {
      text = await readFile(join(dir, 'SKILL.md'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      skill.error = 'SKILL.md is missing';
      skills.push(skill);
      continue;
    }
    skill.lineCount = text.split(/\r?\n/).length;
    const parsed = parseSkillMd(text);
    if (parsed.error) skill.error = parsed.error;
    else skill.data = parsed.data;
    skills.push(skill);
  }
  return skills;
}

export function sourceLabel(skill) {
  if (skill.kind === 'local') return { text: 'local', url: null };
  const entry = skill.lockEntry;
  if (entry.sourceType === 'github') {
    const folder = entry.skillPath ? dirname(entry.skillPath) : '.';
    const url = `https://github.com/${entry.source}${folder === '.' ? '' : `/tree/HEAD/${folder}`}`;
    return { text: entry.source, url };
  }
  return { text: entry.sourceUrl || entry.source, url: null };
}

function cell(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

export function renderCatalog(skills) {
  const upstreamCount = skills.filter((skill) => skill.kind === 'upstream').length;
  const lines = [
    '# Skills catalog',
    '',
    '> Generated by `npm run skills:catalog` from `skills/*/SKILL.md` and `upstream/skills-lock.json`. Do not edit by hand.',
    '',
    `**${skills.length} skills** · ${upstreamCount} upstream (auto-updated) · ${skills.length - upstreamCount} local`,
    '',
    '| Skill | What it does | Source | Invocation |',
    '| --- | --- | --- | --- |',
  ];
  for (const skill of skills) {
    const source = sourceLabel(skill);
    const sourceCell = source.url ? `[${cell(source.text)}](${source.url})` : cell(source.text);
    const description = skill.data?.description ?? `⚠️ ${skill.error ?? 'no description'}`;
    const invocation = skill.data?.['disable-model-invocation'] === true ? 'manual only' : 'automatic + manual';
    lines.push(
      `| [\`${skill.dirName}\`](skills/${skill.dirName}/SKILL.md) | ${cell(description)} | ${sourceCell} | ${invocation} |`,
    );
  }
  if (skills.length === 0) lines.push('| _none yet_ | | | |');
  return `${lines.join('\n')}\n`;
}

// Everything CI checks. Upstream frontmatter problems are warnings: they can only be fixed by their authors.
export async function validateRepo(root) {
  const paths = repoPaths(root);
  const errors = [];
  const warnings = [];

  try {
    const stat = await lstat(paths.link);
    const target = stat.isSymbolicLink() ? (await readlink(paths.link)).split('\\').join('/') : null;
    if (target !== LINK_TARGET) {
      errors.push(`upstream/.agents/skills must be a symlink to ${LINK_TARGET} (fix: rm -rf upstream/.agents/skills && ln -s ${LINK_TARGET} upstream/.agents/skills)`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    errors.push(`upstream/.agents/skills is missing (fix: mkdir -p upstream/.agents && ln -s ${LINK_TARGET} upstream/.agents/skills)`);
  }

  let lock;
  try {
    lock = await readLock(root);
  } catch (error) {
    errors.push(`upstream/skills-lock.json is not valid JSON: ${error.message}`);
    return { errors, warnings };
  }

  let integrity = {};
  try {
    integrity = await readIntegrity(root);
  } catch (error) {
    errors.push(`upstream/integrity.json is not valid JSON: ${error.message}`);
  }
  const upstream = upstreamByDir(lock);
  for (const dirName of Object.keys(integrity)) {
    if (!upstream.has(dirName)) errors.push(`upstream/integrity.json lists ${dirName}, which is not an upstream skill (fix: npm run skills:update)`);
  }

  const unlicensed = new Map();
  for (const [dirName, { key, entry }] of upstream) {
    const dir = join(paths.skills, dirName);
    if (!(await exists(dir))) {
      errors.push(`${key}: listed in upstream/skills-lock.json but skills/${dirName} is missing (fix: npm run skills:update)`);
      continue;
    }
    const license = licenseFile(root, entry);
    const bundled = (await readdir(dir)).some((name) => /^licen[cs]e/i.test(name));
    if (!bundled && !(license && (await exists(license)))) unlicensed.set(entry.sourceUrl || entry.source, license);

    if (!integrity[dirName]) {
      errors.push(`${dirName}: no entry in upstream/integrity.json (fix: npm run skills:update)`);
    } else if ((await hashSkillDir(dir)) !== integrity[dirName]) {
      errors.push(
        `${dirName}: files differ from what the skills CLI installed. Upstream skills must not be edited by hand; ` +
          `undo the edit (git checkout -- skills/${dirName}) or copy it into a new local skill with another name`,
      );
    }
  }
  for (const [source, license] of unlicensed) {
    warnings.push(
      license
        ? `${source}: no license found (licenses/${basename(license)} is missing and the skills carry none); check you may republish it`
        : `${source}: save its license in licenses/ by hand`,
    );
  }

  const skills = await loadSkills(root);
  for (const skill of skills) {
    const where = `skills/${skill.dirName}`;
    if (skill.isSymlink) {
      errors.push(`${where}: must be a real folder, not a symlink`);
      continue;
    }
    const links = await findSymlinks(skill.dir);
    if (links.length) errors.push(`${where}: contains symlinks (${links.join(', ')}); replace them with real files`);
    if (skill.error) {
      errors.push(`${where}: ${skill.error}`);
      continue;
    }
    const issues = frontmatterIssues(skill.data, skill.dirName);
    for (const issue of issues) {
      if (skill.kind === 'upstream') warnings.push(`${where} (upstream, report it to ${skill.lockEntry.source}): ${issue}`);
      else errors.push(`${where}: ${issue}`);
    }
    if (skill.lineCount > MAX_LINES) {
      warnings.push(`${where}: SKILL.md has ${skill.lineCount} lines; keep it under ${MAX_LINES} and move detail into references/`);
    }
  }

  let catalog = null;
  try {
    catalog = await readFile(paths.catalog, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (catalog !== renderCatalog(skills)) errors.push('CATALOG.md is out of date (fix: npm run skills:catalog)');

  return { errors, warnings, skills };
}
