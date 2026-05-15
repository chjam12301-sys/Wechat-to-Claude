# Contributing to Wechat-to-Claude

Thanks for your interest! This project is a fork of
[Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
with concurrency and robustness improvements layered on top. Contributions
that fit either category are welcome.

## Getting set up

**Prerequisites:**
- Node.js >= 18
- macOS or Linux
- A personal WeChat account for testing (the daemon needs a real binding)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed locally

**Setup:**

```bash
git clone git@github.com:chjam12301-sys/Wechat-to-Claude.git
cd Wechat-to-Claude
npm install            # postinstall auto-builds
npm run dev            # tsc --watch — auto-recompile on file changes
```

**Run the daemon for testing:**

```bash
npm run setup            # First time only: scan QR to bind WeChat
npm run daemon -- start  # Start daemon (uses launchd / systemd)
npm run daemon -- logs   # Tail logs while you test
```

After code changes:

```bash
npm run daemon -- restart
```

## Reporting bugs

Open an issue using the **Bug report** template. Include:

- What you sent in WeChat / what command you ran
- What Claude was supposed to do
- What actually happened (full reply / no reply / wrong state, etc.)
- Last ~50 lines of `npm run daemon -- logs` (with sensitive paths /
  prompts / tool inputs redacted — those logs may contain real content)
- OS, Node version (`node -v`), and how you installed (standalone clone /
  symlinked into `~/.claude/skills/` / etc.)

## Proposing features

Open an issue using the **Feature request** template first, before sending
a PR. We care about keeping this a focused **bridge** — the goal is "let
Claude Code work over WeChat", not "build a chatbot platform". Features
that don't generalize beyond a specific use case will likely be declined.

If your idea is clearly useful but very specific (e.g. a custom persona,
domain-specific commands), consider implementing it as a Claude Code Skill
that this bridge can trigger via `/<skill-name>`.

## Sending a pull request

1. Fork the repo and branch off `main`: `git checkout -b fix/your-fix`
2. Make focused commits — one logical change per commit
3. Run `npm run build` to make sure TypeScript compiles cleanly
4. Test against a real WeChat binding if your change touches messaging,
   permissions, session state, or the daemon lifecycle
5. Update `CHANGELOG.md` under `## [Unreleased]` with a one-line entry
6. Open the PR; describe the problem, your fix, and how you tested it

### Commit message style

Follow the [Conventional Commits](https://www.conventionalcommits.org/) flavor:

- `feat: add /something command`
- `fix: handle race in xxx`
- `docs: update install instructions`
- `refactor: extract permission queue into module`
- `chore: bump dependency X`

Imperative mood, present tense ("add", not "added"). Keep the first line
under 72 chars; put detail in the body. Reference issues with `Closes #N`
or `Refs #N` where applicable.

## Contributing back to upstream

If your fix is generally applicable (not specific to an improvement layered
in this fork), please consider opening the same PR against
[Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
as well — that's good open-source citizenship and helps the whole community.
We also try to track upstream changes and pull them in periodically.

## Code style

- TypeScript strict mode (see `tsconfig.json`)
- 2-space indent
- Prefer `async`/`await` over raw promise chains
- **Don't introduce new runtime dependencies without discussion** — this
  project intentionally has a minimal dep tree (3 runtime deps total).
  Each new dep is a maintenance burden and a potential supply-chain risk
- Follow existing comment patterns: short header comment block at the top
  of new modules explaining "why this exists" and "failure policy"

## License

By contributing, you agree your contributions will be licensed under MIT,
the same as the rest of the project.
