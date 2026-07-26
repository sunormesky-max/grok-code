# Codex Feature Parity for GrokCode

Goal: GrokCode must implement **at least all features** of a Codex-style coding agent (command-center desktop agent powered by Grok Build CLI as the core).

This is the minimum bar. Grok Build (via local `grok` CLI) is the intelligence core. The desktop provides the full UI/UX flight deck.

## Core Codex Features (minimum required)

1. **Natural language tasking**
   - User types request in composer → agent executes multi-step task
   - Streaming response + thoughts

2. **Agent reasoning visibility**
   - Thoughts / reasoning chunks shown in Live
   - Not just final answer

3. **Tool use & execution**
   - Agent calls tools (read, write, search, terminal, etc.)
   - Tool starts, progress (in_progress if available), results visible
   - Even in limited backend: infer from output + fs effects

4. **Code change proposal & review (Diff)**
   - Changes captured as before/after
   - Unified/split diff view
   - Hunk-level keep/reject + file accept
   - Multi-select, restore to baseline
   - Binary/truncation honesty

5. **Live timeline & activity**
   - Real-time events: text, thought, tool, file changes
   - Virtualized for long runs
   - Phase / silence / progress indicators

6. **Plan mode**
   - Agent can enter plan mode
   - Show proposed plan
   - User approves (`exit_plan_mode`) or edits
   - Interactive approval bar

7. **Interactive clarification**
   - Agent asks user questions
   - Questionnaire / answer bar
   - Global Inbox for cross-task items

8. **Permission / tool approval**
   - Parked permission requests
   - User grants/denies
   - YOLO / always-approve option

9. **File system awareness**
   - Project tree
   - Live updates on disk changes (watcher driven)
   - @file mentions, search, outline

10. **Context & memory**
    - Multi-turn with inheritance (L0-L3)
    - Session persistence and restore
    - Rules injection

11. **Model & behavior control**
    - Switch models
    - Reasoning effort (low/medium/high/xhigh)
    - Work modes (via CLI native)
    - Stop / interrupt running agent

12. **Multi-project & multi-task**
    - Open multiple workspaces
    - Parallel tasks with fair streaming
    - Per-project tabs, Live/Code/Diff isolated

13. **Review & iteration desk**
    - Dedicated Diff tab for review
    - Accept-and-next, filters
    - Storyboard / checkpoint comparison (advanced)

14. **Execution feedback & terminal**
    - Command outputs visible
    - Terminal integration / external editor hooks
    - Error surfacing

15. **Advanced agent UX**
    - Command palette
    - Global search
    - Inbox for parked interactions
    - Layout presets (Agent / Pilot / Review / Full — Codex style)
    - Undo/restore at multiple levels

## Current Status (audited 2026-07-26)

- UI surfaces complete for all 15 items: Live (virtualized), Diff (hunk keep/reject, multi-select, restore), Plan approval, Ask/Inbox, watcher fs:changed → record + Live, multi-project/task, streaming thoughts/text, model/effort, stop, context, etc.
- Watcher bridge (fs.watch + onFsChanged + recordFileChangeForProject + pushLiveEvent) makes Diff + Live work even without tool events from CLI.
- 2026-07-26 enhancement: onFsChanged now always pushes 'write' Live event during running tasks → Codex "visible actions" and timeline work in headless.
- Tool cards with rich meta (args, in_progress) are ACP-strong; headless falls back to text + fs inference (still delivers the "agent edited files, review them" flow).
- Transport: default allowHeadlessFallback + clean fallback now lets you actually use the full feature set instead of hard blocking on 403.

All listed Codex features are possessed in the host UI. Backend (Grok Build CLI) drives what it can; host makes the desktop experience complete.

## Action

Audit each feature:
- Is the UI control always present?
- Does it light up from available CLI output + fs watcher?
- Can user perform the full flow (instruct → see reasoning → see/approve plan → see tools/changes → review & accept → iterate)?

Any feature not fully usable must be completed or approximated so the app "具备" it.

This takes priority over transport purity debates.
