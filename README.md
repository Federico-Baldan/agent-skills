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

Nothing reaches your agents the moment its author publishes it. A new skill version is picked up only after it has sat unchanged in its own repo for 7 days, and a new tool version (Renovate) only once it's 7 days old. Then it arrives as a pull request, CI validates it, and it's merged automatically once the checks pass. Your machines only ever see what's merged.

## Setup

```bash
git clone https://github.com/Federico-Baldan/agent-skills.git
cd agent-skills
npm ci
```

On GitHub, once, [install the Renovate app](https://github.com/apps/renovate/installations/new) and give it access to this repo. GitHub only lets you install an app from the browser; everything else below is already configured (via `gh api`):

- **Auto-merge** is allowed on the repo, and merged branches are deleted.
- **`main` is protected by a ruleset**: pull requests can merge only when the `Validate skills` and `Skills CLI smoke test` checks from GitHub Actions pass; force pushes and deleting `main` are blocked. Repo admins (you) can still push directly.
- **Actions may open pull requests** (Settings → Actions → General), which the weekly update needs.
- **Repository variables** (Settings → Secrets and variables → Actions → Variables):
  - `AUTO_MERGE_SKILL_UPDATES = true`: weekly skill PRs merge by themselves once the checks pass. Set it to `false` to review each one by hand.
  - `SKILL_MIN_AGE_DAYS` (default 7 when unset): how long a skill must sit unchanged upstream before it's taken.

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
| update upstream skills now | `npm run skills:update` (add `-- --min-age 7` to apply the 7-day rule) |
| list everything | `npm run skills:list` |
| check before committing | `npm test && npm run skills:validate` |

`skill:add` also saves the upstream repo's license in `licenses/` (republishing MIT and similar code requires it) and regenerates the catalog. Anything added with `skill:add` updates automatically; imported and self-written skills stay as you left them. Run `npm run skills -- help` for every option.

## What runs automatically

| Workflow | When | What it does |
| --- | --- | --- |
| `Update skills` | Mondays 05:17 UTC, or by hand | `skills update` for every upstream skill that's been unchanged upstream for 7+ days; opens (and auto-merges) one PR if anything changed |
| `Validate` | pushes to `main`, every PR, and each bot update | unit tests, spec and integrity checks, CLI smoke test, builds the zips |
| Renovate | Monday mornings (Europe/Rome) | bumps the `skills` CLI, Node and pinned actions once a release is 7 days old; auto-merges non-major bumps after CI; weekly lock file maintenance |

Validation fails if a `SKILL.md` breaks the spec (name, description, length limits), if an upstream skill no longer matches its hash in `upstream/integrity.json` (someone edited it by hand), if any skill contains a symlink (it could smuggle a local file into an upload zip), or if `CATALOG.md` is stale. GitHub doesn't start workflows (or count their checks) for its own bot's pushes, so the update job runs the tests, the validation and the pinned CLI itself and reports `Validate skills` and `Skills CLI smoke test` on the bot commit, each linking to that run. GitHub may also list a Validate run marked "action required" on bot PRs; it isn't needed and can be ignored. GitHub pauses scheduled workflows after 60 days without repo activity; Renovate's weekly PRs normally prevent that, and re-enabling is one click in the Actions tab.

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
