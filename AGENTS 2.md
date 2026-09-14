# WatchCue Codex Instructions

These instructions apply to the entire repository.

## Preferred Agent Roles

Use the following role, model, and reasoning profile when the Codex environment supports role-based delegation:

| Role | Model | Reasoning effort | Purpose |
|---|---|---:|---|
| Plan Mode | `gpt-5.6-luna` | Low | Turn the request into a focused implementation plan without over-analysing. |
| Code Explorer | `gpt-5.6-luna` | Medium | Inspect the codebase, trace behaviour, locate relevant files, and identify risks. |
| Quick Code Implementer | `gpt-5.6-luna` | High | Make small, well-defined changes affecting one or two files. |
| Code Implementer | `gpt-5.6-luna` | High | Implement complete features and non-trivial fixes with validation. |
| Code Reviewer | `gpt-5.6-sol` | Medium | Review the completed diff for bugs, regressions, security, accessibility, and quality. |
| Commit Pusher | `gpt-5.6-luna` | Low | Stage, commit, and push only completed and approved work. |

The role names above describe the intended workflow. Never claim that a particular model or reasoning level was used unless the active Codex configuration actually selected it.

## Default Workflow

For each development task:

1. **Plan Mode**
   - Restate the objective in one or two sentences.
   - Identify the likely files or areas involved.
   - Produce a short, actionable plan.
   - Avoid speculative architecture work.

2. **Code Explorer**
   - Inspect the repository before editing.
   - Locate the relevant Swift, SwiftUI, model, service, asset, test, and Xcode configuration files.
   - Trace the current execution and data flow.
   - Check existing conventions before proposing new patterns.
   - Report the likely cause of a bug or the best insertion point for a feature.
   - Do not edit files while acting only as explorer.

3. **Choose an Implementer**
   - Use **Quick Code Implementer** when the requested change is clear, isolated, and affects no more than one or two files.
   - Use **Code Implementer** for features, multi-file changes, architectural work, migrations, state-management changes, or non-trivial bug fixes.

4. **Implementation**
   - Make the smallest complete change that satisfies the request.
   - Follow existing project architecture and naming conventions.
   - Avoid unrelated cleanup, renaming, or refactoring.
   - Do not leave placeholders, mock implementations, dead code, or unexplained TODOs.
   - Add or update tests when practical.
   - Handle relevant loading, empty, success, and error states.

5. **Validation**
   - Review the complete diff before declaring the task finished.
   - Run the most relevant available tests.
   - Run an appropriate `xcodebuild` build or test command when the environment supports it.
   - Distinguish pre-existing failures from failures introduced by the change.
   - Do not claim a build or test passed unless the command actually completed successfully.

6. **Code Review**
   - Review the full diff after implementation.
   - Prioritise functional bugs, regressions, data loss, privacy, security, concurrency, state-management, accessibility, and missing validation.
   - Give exact file paths and locations for findings.
   - Ignore purely subjective style preferences unless they conflict with repository conventions.
   - Fix valid high- and medium-severity findings before finishing.

7. **Final Report**
   - Summarise what changed.
   - List every modified file.
   - State what validation was run and its result.
   - Mention any unresolved limitation or risk clearly.

## WatchCue Swift and SwiftUI Rules

- Preserve the existing WatchCue visual language and design system.
- Prefer existing reusable components, modifiers, services, models, and utilities over creating duplicates.
- Keep views focused and split large views into sensible reusable components.
- Follow the project’s existing state-management pattern.
- Keep business logic out of view bodies where practical.
- Use structured concurrency correctly and update UI state on the appropriate actor.
- Avoid force unwraps and force casts unless safety is guaranteed and documented by the surrounding code.
- Handle cancellation and errors for asynchronous operations where relevant.
- Preserve light mode and dark mode support.
- Support Dynamic Type, VoiceOver labels, sufficient touch targets, and sensible accessibility ordering.
- Keep layouts usable on smaller supported iPhone screens.
- Use the asset catalogue for production images, icons, and named colours where appropriate.
- Prefer SF Symbols only when they fit the approved design.
- Do not manually edit `project.pbxproj` unless necessary.
- Do not add third-party dependencies without explicit approval.
- Do not change deployment targets, signing settings, bundle identifiers, capabilities, or entitlements unless explicitly requested.

## Scope and Safety

- Never modify unrelated files simply because they are nearby.
- Preserve backwards compatibility unless the request explicitly requires a breaking change.
- Do not expose API keys, tokens, secrets, personal data, or signing credentials.
- Do not access or alter production data unless explicitly requested and clearly authorised.
- Do not delete user data or perform destructive migrations without an approved migration and rollback plan.
- Do not suppress compiler warnings merely to make a build appear clean.

## Git Rules

- Do not commit or push unless the user explicitly asks for it.
- Before committing, inspect `git status` and the full diff.
- Stage only files belonging to the requested task.
- Never include secrets, credentials, `.DS_Store`, DerivedData, build products, temporary files, or unrelated local changes.
- Use a concise commit message that describes the actual change.
- Never force-push, reset, amend, rebase, rewrite history, or bypass hooks unless the user explicitly requests the exact action.
- Push only after implementation, validation, and review are complete.
- Report the branch, commit hash, commit message, and push result.

## Response Behaviour

- Be direct and practical.
- Ask a question only when a missing detail materially blocks safe implementation.
- Otherwise, inspect the repository and make a grounded decision from the existing code.
- Do not claim work is complete when validation is still failing.
