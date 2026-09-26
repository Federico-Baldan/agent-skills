# agent-skills

Every agent skill I use, in one repo, kept up to date on its own. Skills follow the open [Agent Skills](https://agentskills.io/specification) format (a folder with a `SKILL.md`), so one copy serves Claude Code, Claude.ai, Codex and ChatGPT, Cursor, GitHub Copilot, Gemini CLI and the other agents the [`skills` CLI](https://github.com/vercel-labs/skills) knows about.

See [CATALOG.md](CATALOG.md) for what's inside.

## How updates flow

```
skills.sh / any git repo ──(weekly GitHub Action: skills update)──► pull request here
                                                                      │ merge
                                                                      ▼
your machines ◄──(npx skills update -g, daily timer)── Federico-Baldan/agent-skills
Claude.ai / ChatGPT ◄──(zip upload)── skill-zips artifact of the Validate workflow
```

Upstream skills never land in your agents unreviewed: they reach the repo as a pull request, CI validates them, and your machines only see what's merged.

## Setup

```bash
git clone https://github.com/Federico-Baldan/agent-skills.git
cd agent-skills
npm ci
```

On GitHub, once:

- Install the [Renovate app](https://github.com/apps/renovate) on this repo. It keeps the `skills` CLI, Node and the GitHub Actions pinned and current, and merges minor/patch bumps after CI passes.
- Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" must be on, or the weekly update can't open its PR. (Already enabled for this repo.)
- Optional: set the repository variable `AUTO_MERGE_SKILL_UPDATES` to `true` (Settings → Secrets and variables → Actions → Variables) if you want the weekly skill updates merged without review.

## Use the skills in your agents

**Coding agents** (Claude Code, Codex, Cursor, Copilot, Gemini CLI, OpenCode, …):

```bash
npm run skills:install                                  # every skill, every agent detected on this machine
npm run skills:install -- --agent claude-code codex     # pick agents
npm run skills:install -- --skill grill-me grilling     # pick skills
```

That's `npx skills add Federico-Baldan/agent-skills -g --skill '*' -y` under the hood, so it works without cloning too. Because the source is this GitHub repo, `npx skills update -g` later pulls whatever you've merged here. (`--local` installs the working copy instead: handy for trying a skill before pushing, but it's a snapshot that `update -g` won't refresh.) To run the update every day on Linux:

```bash
npm run skills:autoupdate -- enable     # systemd user timer; also: status, run, disable
```

The timer uses the `skills` version pinned in `package.json`; re-run `enable` after pulling to move it forward. On macOS or Windows, schedule `npx --yes skills update --global --yes` with launchd or Task Scheduler instead. Either way it updates *all* your globally installed skills, not only the ones from this repo, and reinstalls each into every agent it detects on the machine.

**Claude.ai / Claude Desktop and ChatGPT** don't read folders from disk; they take one zip per skill. Run `npm run skills:package` (or download the `skill-zips` artifact from the latest Validate run) and upload `dist/<skill>.zip`: in Claude under [Customize → Skills](https://claude.ai/customize/skills) → Add, in ChatGPT under Skills → Create → Upload from your computer. For `grill-me`, upload `grilling.zip` too, since `grill-me` just hands off to it.

## Manage skills

| I want to… | Command |
| --- | --- |
| add a skill from [skills.sh](https://skills.sh) or any git repo | `npm run skill:add -- mattpocock/skills grill-me grilling` |
| see what a repo offers | `npm run skill:add -- mattpocock/skills --list` |
| add from GitLab or any git URL | `npm run skill:add -- https://gitlab.com/owner/repo my-skill` |
| bring in a skill that isn't in git (folder or zip) | `npm run skill:import -- ~/Downloads/my-skill.zip` |
| write my own | `npm run skill:new -- my-skill --description "What it does. Use when…"` |
| remove one | `npm run skill:remove -- my-skill` |
| update upstream skills now | `npm run skills:update` |
| list everything | `npm run skills:list` |
| check before committing | `npm test && npm run skills:validate` |

`skill:add` also saves the upstream repo's license in `licenses/` (republishing MIT and similar code requires it) and regenerates the catalog. Anything added with `skill:add` updates automatically; imported and self-written skills stay as you left them. Run `npm run skills -- help` for every option.

## What runs automatically

| Workflow | When | What it does |
| --- | --- | --- |
| `Update skills` | Mondays 05:17 UTC, or by hand | `skills update` for every upstream skill; opens or refreshes one PR if anything changed |
| `Validate` | pushes to `main`, every PR, and each bot update | unit tests, spec and integrity checks, CLI smoke test, builds the zips |
| Renovate | Monday mornings (Europe/Rome) | bumps the `skills` CLI, Node and pinned actions; weekly lock file maintenance |

Validation fails if a `SKILL.md` breaks the spec (name, description, length limits), if an upstream skill no longer matches its hash in `upstream/integrity.json` (someone edited it by hand), if any skill contains a symlink (it could smuggle a local file into an upload zip), or if `CATALOG.md` is stale. The update job validates before it opens the PR and then starts the Validate workflow on the bot branch, because GitHub doesn't trigger workflows from its own bot's pushes. GitHub pauses scheduled workflows after 60 days without repo activity; Renovate's weekly PRs normally prevent that, and re-enabling is one click in the Actions tab.

Only established tooling is involved: Vercel's `skills` CLI, GitHub's own actions and `gh`, Mend's Renovate, and the standard `yaml` parser. Every action is pinned to a commit SHA.

## Layout

```
skills/<name>/SKILL.md      every skill (what agents install)
upstream/skills-lock.json   which skills come from other repos (written by the skills CLI)
upstream/integrity.json     hash of each upstream skill as installed, to catch hand edits
upstream/.agents/skills     symlink to ../../skills, where the CLI writes
licenses/                   licenses of the upstream repos
CATALOG.md                  generated list of skills
scripts/                    management CLI and validation
AGENTS.md / CLAUDE.md       instructions for AI agents working on this repo
```

The symlink needs a filesystem that supports them (Linux, macOS, or Windows with Developer Mode and `git config core.symlinks true`).

## Licenses

The scripts in this repo are MIT. Each upstream skill keeps its own license; the source column in [CATALOG.md](CATALOG.md) links to it and the text lives in [`licenses/`](licenses).
