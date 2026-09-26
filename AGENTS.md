# AGENTS.md

This repo is the single source of truth for the user's agent skills. Every skill follows the open [Agent Skills spec](https://agentskills.io/specification) (a folder with a `SKILL.md`), so the same folder works in Claude Code, Codex/ChatGPT, Cursor, GitHub Copilot, Gemini CLI and any other agent the [`skills` CLI](https://github.com/vercel-labs/skills) supports.

## Layout

- `skills/<name>/` holds every skill; this is the folder agents install from.
- `upstream/skills-lock.json` lists the skills that come from other repos (skills.sh or any git URL). The `skills` CLI writes it.
- `upstream/integrity.json` holds the hash of each upstream skill folder as installed. The scripts write it; never edit it.
- `upstream/.agents/skills` is a symlink to `../../skills`, so the CLI running in `upstream/` writes straight into `skills/`. Never replace it with a real folder.
- `licenses/<owner>__<repo>.txt` stores the license of each upstream repo whose skills we republish.
- `CATALOG.md` is generated. Never edit it by hand.
- `scripts/skills.mjs` is the management CLI; `scripts/lib.mjs` has the validation logic; `test/` covers it.

A skill in `skills/` that isn't in the lock file is a **local** skill: written by the user or imported from a zip/folder. It never auto-updates.

## Rules

1. Change skills only through the npm scripts below. Never run a project-scope `npx skills add`/`update` in the repo root: the CLI would install into a root `.agents/skills` instead of `skills/`, create `.claude/` and other per-agent folders, and (because one agent, OpenClaw, uses `skills/` as its own folder) scatter links into `skills/`.
2. Never edit an upstream skill in place. Validation compares every upstream folder with its hash in `upstream/integrity.json` and fails on any change. To customise one, copy it into a local skill with a different name.
3. Skills must not contain symlinks; validation rejects them.
4. Inside `upstream/`, never run `skills remove` without skill names (or with `--all`): through the symlink it also sees local skills and would delete them.
5. Some skills depend on others. `grill-me` only tells the agent to load `grilling`, so keep both. Check a skill's body for references to other skills before removing it.
6. After any change run `npm test` and `npm run skills:validate`; both must pass before committing. Commit messages use Conventional Commits (`feat(skills): add grill-me`).

## Commands

```bash
npm ci                                            # once, installs the pinned skills CLI
npm run skill:add -- <source> <skill...>          # e.g. mattpocock/skills grill-me grilling
npm run skill:add -- <source> --list              # see what a source offers
npm run skill:new -- <name> --description "..."   # scaffold a local skill
npm run skill:import -- <folder|file.zip>         # skills that aren't in any git repo
npm run skill:remove -- <skill...>
npm run skills:update [-- --min-age 7]            # pull new upstream versions (CI waits 7 days)
npm run skills:validate                           # spec + integrity checks (CI runs this)
npm run skills:catalog                            # regenerate CATALOG.md
npm run skills:package                            # dist/<skill>.zip for Claude.ai / ChatGPT
npm run skills:install                            # install this repo's skills on this machine
npm test
```

## Writing a local skill

- `name`: 1-64 chars, lowercase letters, digits and single hyphens, equal to the folder name.
- `description`: up to 1024 chars. Say what the skill does *and* when to use it, with the words a user would actually type; agents pick skills from this line alone.
- Keep `SKILL.md` under 500 lines. Move long material into `references/`, runnable code into `scripts/`, templates into `assets/`, and link them from `SKILL.md` one level deep.
- Optional spec fields: `license`, `compatibility` (max 500 chars), `metadata` (string to string map), `allowed-tools` (space-separated string). Agent-specific keys such as Claude Code's `disable-model-invocation: true` are fine.
