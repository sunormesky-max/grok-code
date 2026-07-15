---
name: skill-pack-template
description: >
  Template for GrokCode skills with progressive disclosure. Use when creating a new
  skill package (scripts / references / assets layout).
---

# Skill pack template

Progressive loading (inspired by common agent skill layouts, GrokCode-native):

1. **Metadata** — name + description (always available for matching)
2. **This body** — short procedure when skill triggers
3. **references/** — load only when needed (schemas, long docs)
4. **scripts/** — deterministic helpers the agent can run
5. **assets/** — templates/images for output, not for context

## When to use

- Scaffolding a new reusable workflow for the user
- Packaging domain knowledge without stuffing the whole chat context

## Steps

1. Copy this folder to `~/.grok/skills/<your-skill>/` or project `.grok/skills/`
2. Edit frontmatter `name` / `description` (third person, specific triggers)
3. Keep this body under ~2–3k words; move details to `references/`
4. Add scripts under `scripts/` for repeated deterministic work
5. Test by asking the user to invoke the skill by intent, not by filename

## Notes

- Prefer imperative instructions
- Do not store secrets in skills
