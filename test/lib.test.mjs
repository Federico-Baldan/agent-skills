import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LINK_TARGET,
  SKILL_NAME_RE,
  findSymlinks,
  frontmatterIssues,
  hashSkillDir,
  lastUpstreamChange,
  licenseFile,
  loadSkills,
  parseSkillMd,
  readLock,
  renderCatalog,
  sanitizeName,
  validateRepo,
  writeIntegrity,
} from '../scripts/lib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('skill names', () => {
  test('accepts spec-valid names', () => {
    for (const name of ['a', 'pdf', 'grill-me', 'code-review-2', 'x1-y2-z3']) assert.match(name, SKILL_NAME_RE);
  });
  test('rejects invalid names', () => {
    for (const name of ['', 'PDF', '-pdf', 'pdf-', 'pdf--x', 'pdf_x', 'pdf x', 'pdf.x']) assert.doesNotMatch(name, SKILL_NAME_RE);
  });
  test('sanitizeName matches the skills CLI folder naming', () => {
    assert.equal(sanitizeName('Grill Me'), 'grill-me');
    assert.equal(sanitizeName('grill-me'), 'grill-me');
    assert.equal(sanitizeName('--Weird__Name!!'), 'weird__name');
    assert.equal(sanitizeName('!!!'), 'unnamed-skill');
  });
});

describe('parseSkillMd', () => {
  test('parses frontmatter', () => {
    assert.deepEqual(parseSkillMd('---\nname: a\ndescription: b\n---\nbody').data, { name: 'a', description: 'b' });
  });
  test('handles CRLF and a BOM', () => {
    assert.deepEqual(parseSkillMd('﻿---\r\nname: a\r\ndescription: b\r\n---\r\n').data, { name: 'a', description: 'b' });
  });
  test('reports missing or broken frontmatter', () => {
    assert.match(parseSkillMd('# no frontmatter').error, /missing YAML frontmatter/);
    assert.match(parseSkillMd('---\nname: [oops\n---\n').error, /invalid YAML/);
    assert.match(parseSkillMd('---\n- a list\n---\n').error, /mapping/);
  });
});

describe('frontmatterIssues', () => {
  const valid = { name: 'my-skill', description: 'Does X. Use when Y.' };
  test('valid frontmatter has no issues', () => {
    assert.deepEqual(frontmatterIssues(valid, 'my-skill'), []);
    assert.deepEqual(
      frontmatterIssues({ ...valid, license: 'MIT', compatibility: 'Needs git', metadata: { author: 'me' }, 'allowed-tools': 'Read' }, 'my-skill'),
      [],
    );
  });
  test('flags each spec violation', () => {
    const cases = [
      [{ ...valid, name: 'other' }, 'my-skill', /must match its folder/],
      [{ ...valid, name: 'My-Skill' }, 'My-Skill', /lowercase/],
      [{ ...valid, name: 'a'.repeat(65) }, 'a'.repeat(65), /longer than 64/],
      [{ name: 'my-skill' }, 'my-skill', /description.*required/],
      [{ ...valid, description: 'x'.repeat(1025) }, 'my-skill', /longer than 1024/],
      [{ ...valid, description: 'TODO: fill me' }, 'my-skill', /TODO/],
      [{ ...valid, compatibility: 'x'.repeat(501) }, 'my-skill', /compatibility/],
      [{ ...valid, metadata: { version: 1 } }, 'my-skill', /metadata/],
      [{ ...valid, 'allowed-tools': ['Read'] }, 'my-skill', /allowed-tools/],
    ];
    for (const [data, dir, expected] of cases) assert.match(frontmatterIssues(data, dir).join('\n'), expected);
  });
});

describe('hashSkillDir and findSymlinks', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-skills-hash-'));
    await mkdir(join(dir, 'references'));
    await writeFile(join(dir, 'SKILL.md'), 'a');
    await writeFile(join(dir, 'references', 'x.md'), 'b');
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('is stable, ignores OS clutter and changes with content', async () => {
    const first = await hashSkillDir(dir);
    assert.equal(await hashSkillDir(dir), first);
    await writeFile(join(dir, '.DS_Store'), 'junk');
    assert.equal(await hashSkillDir(dir), first);
    await writeFile(join(dir, 'references', 'x.md'), 'changed');
    assert.notEqual(await hashSkillDir(dir), first);
  });

  test('finds symlinks at any depth', async () => {
    assert.deepEqual(await findSymlinks(dir), []);
    await symlink('/etc/hostname', join(dir, 'references', 'leak'));
    assert.deepEqual(await findSymlinks(dir), ['references/leak']);
    await rm(join(dir, 'references', 'leak'));
  });
});

describe('licenseFile', () => {
  test('names one file per GitHub repo and skips other sources', () => {
    assert.equal(licenseFile('/r', { sourceType: 'github', source: 'mattpocock/skills' }), join('/r', 'licenses', 'mattpocock__skills.txt'));
    assert.equal(licenseFile('/r', { sourceType: 'gitlab', source: 'owner/repo' }), null);
    assert.equal(licenseFile('/r', { sourceType: 'github', source: '../evil' }), null);
  });
});

describe('lastUpstreamChange', () => {
  const fakeFetch = (calls, body, ok = true) => async (url, options) => {
    calls.push({ url: String(url), auth: options.headers.authorization });
    return { ok, status: ok ? 200 : 403, json: async () => body };
  };

  test('asks GitHub for the last commit touching the skill folder', async () => {
    const calls = [];
    const date = await lastUpstreamChange(
      { sourceType: 'github', source: 'mattpocock/skills', skillPath: 'skills/productivity/grill-me/SKILL.md' },
      { fetchImpl: fakeFetch(calls, [{ commit: { committer: { date: '2026-09-01T10:00:00Z' } } }]), token: 't0k' },
    );
    assert.equal(date.toISOString(), '2026-09-01T10:00:00.000Z');
    assert.equal(calls[0].url, 'https://api.github.com/repos/mattpocock/skills/commits?per_page=1&path=skills%2Fproductivity%2Fgrill-me');
    assert.equal(calls[0].auth, 'Bearer t0k');
  });

  test('returns null for non-GitHub sources and throws on API errors', async () => {
    assert.equal(await lastUpstreamChange({ sourceType: 'gitlab', source: 'a/b' }, { fetchImpl: fakeFetch([], []) }), null);
    await assert.rejects(
      lastUpstreamChange({ sourceType: 'github', source: 'a/b', skillPath: 'SKILL.md' }, { fetchImpl: fakeFetch([], {}, false), token: '' }),
      /HTTP 403/,
    );
    await assert.rejects(
      lastUpstreamChange({ sourceType: 'github', source: 'a/b', skillPath: 'SKILL.md' }, { fetchImpl: fakeFetch([], []), token: '' }),
      /no commits/,
    );
  });
});

describe('renderCatalog', () => {
  test('escapes table characters and marks manual-only skills', () => {
    const output = renderCatalog([
      { dirName: 'a', kind: 'local', data: { description: 'pipes | and\nnewlines', 'disable-model-invocation': true } },
    ]);
    assert.match(output, /pipes \\\| and newlines/);
    assert.match(output, /manual only/);
    assert.match(output, /\*\*1 skills\*\* · 0 upstream/);
  });
});

describe('validateRepo on a temporary repo', () => {
  let root;
  const lock = { version: 1, skills: { up: { source: 'owner/repo', sourceType: 'github', skillPath: 'skills/up/SKILL.md' } } };
  const writeState = async (repo) => {
    await writeFile(join(repo, 'upstream', 'skills-lock.json'), JSON.stringify(lock));
    await writeIntegrity(repo, { up: await hashSkillDir(join(repo, 'skills', 'up')) });
    await writeFile(join(repo, 'CATALOG.md'), renderCatalog(await loadSkills(repo)));
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-skills-test-'));
    await mkdir(join(root, 'skills', 'up'), { recursive: true });
    await writeFile(join(root, 'skills', 'up', 'SKILL.md'), '---\nname: up\ndescription: Upstream skill.\n---\nbody\n');
    await mkdir(join(root, 'skills', 'mine'), { recursive: true });
    await writeFile(join(root, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: My skill. Use when testing.\n---\nbody\n');
    await mkdir(join(root, 'upstream', '.agents'), { recursive: true });
    await symlink(LINK_TARGET, join(root, 'upstream', '.agents', 'skills'), 'dir');
    await writeFile(join(root, 'skills', 'up', 'LICENSE'), 'MIT');
    await writeState(root);
  });
  after(() => rm(root, { recursive: true, force: true }));

  test('a consistent repo is valid', async () => {
    const { errors, warnings, skills } = await validateRepo(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, [], 'a LICENSE shipped inside the skill counts as its license');
    assert.deepEqual(skills.map((skill) => [skill.dirName, skill.kind]), [['mine', 'local'], ['up', 'upstream']]);
  });

  test('flags symlinks, missing and stale integrity entries', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'agent-skills-test-'));
    try {
      await cp(root, scratch, { recursive: true, verbatimSymlinks: true });
      await symlink('/etc/hostname', join(scratch, 'skills', 'mine', 'leak'));
      await writeIntegrity(scratch, { gone: 'abc' });
      const errors = (await validateRepo(scratch)).errors.join('\n');
      assert.match(errors, /skills\/mine: contains symlinks \(leak\)/);
      assert.match(errors, /up: no entry in upstream\/integrity\.json/);
      assert.match(errors, /integrity\.json lists gone/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('detects a hand-edited upstream skill', async () => {
    const file = join(root, 'skills', 'up', 'SKILL.md');
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}edited\n`);
    try {
      assert.match((await validateRepo(root)).errors.join('\n'), /up: files differ/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('upstream spec problems are warnings, local ones are errors', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'agent-skills-test-'));
    try {
      await cp(root, scratch, { recursive: true, verbatimSymlinks: true });
      await writeFile(join(scratch, 'skills', 'up', 'SKILL.md'), '---\nname: Up\ndescription: Upstream skill.\n---\n');
      await writeFile(join(scratch, 'skills', 'mine', 'SKILL.md'), '---\nname: Mine\ndescription: Mine.\n---\n');
      await writeState(scratch);
      const { errors, warnings } = await validateRepo(scratch);
      assert.match(warnings.join('\n'), /skills\/up \(upstream/);
      assert.match(errors.join('\n'), /skills\/mine: `name`/);
      assert.doesNotMatch(errors.join('\n'), /skills\/up/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('detects a missing upstream skill, a stale catalog and a broken symlink', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'agent-skills-test-'));
    try {
      await cp(root, scratch, { recursive: true, verbatimSymlinks: true });
      await rm(join(scratch, 'skills', 'up'), { recursive: true });
      await rm(join(scratch, 'upstream', '.agents', 'skills'));
      const errors = (await validateRepo(scratch)).errors.join('\n');
      assert.match(errors, /skills\/up is missing/);
      assert.match(errors, /CATALOG\.md is out of date/);
      assert.match(errors, /upstream\/\.agents\/skills is missing/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
