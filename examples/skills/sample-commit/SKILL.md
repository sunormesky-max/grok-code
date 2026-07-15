---
name: sample-commit
description: Create a clear conventional commit from staged changes. Use when the user asks to commit or /commit.
---

# Sample commit skill

1. Run `git status` and `git diff --staged`
2. Summarize intent in one sentence
3. Propose a conventional commit message (`feat:`, `fix:`, `docs:`, …)
4. Only commit after the user confirms (unless they said to commit immediately)
