---
name: Bug report
about: Something is broken or behaving unexpectedly
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A clear, one-paragraph description of the problem -->

## What you expected

<!-- What you thought would happen instead -->

## Reproduction

1. Send `...` in WeChat
2. Claude does `...`
3. ...

## Daemon logs

<!-- Paste the last ~50 lines of `npm run daemon -- logs`. REDACT any
     sensitive content first — logs may contain your prompts, file paths,
     and tool inputs. -->

```
(paste logs here)
```

## Environment

- OS: <!-- macOS 14.5 / Ubuntu 22.04 / etc. -->
- Node version: <!-- output of `node -v` -->
- npm version: <!-- output of `npm -v` -->
- Installed as: <!-- standalone clone / symlinked into ~/.claude/skills/ / etc. -->
- Wechat-to-Claude version / git commit: <!-- check package.json or `git rev-parse --short HEAD` -->
- Permission mode at the time: <!-- default / acceptEdits / plan / auto -->

## Additional context

<!-- Anything else relevant — recent changes you made, multi-account setup,
     specific cwd, custom system prompt, mid-burst message timing, etc. -->
