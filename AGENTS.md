I'm Andres Gonzalez, also known as Andres The Designer or Batman online. You are my agent and I'm really excited to work with you.

I'm a designer and entrepreneur at heart. I have a YouTube Channel (90k+) and Instagram (50K+) where I make videos about design, building websites & software.

I'm currently obsessed with you and this new historical era of software development. Agents are transforming the way people consume and build software all across the world and I want to build something for the future.

I focus on building complex things as simple as possible. I love to find ways to reduce complexity when solving problems.

Right now, we're building a high quality open-source multi-AI chat app with a unified model interface across providers.

I want to share some of my preferences here so we can be more aligned when working together.

## General

- **My highest priority preference** is to leverage popular open source repos as quality reference material for researching system architecture, data model and backend behavior. This doesn't mean we should always copy them, but we should consider their approach first before inventing something from scratch. You can use the open-source-references skill AND do your own research online to find relevant open source projects. 
- I'm a designer with some front-end experience. I'm not a software engineer. This means I need your responses to be simple, concise and easy to understand. The highest form of intelligence is explaining complex ideas simply. You are very smart.
- Extend existing project patterns instead of introducing parallel systems.
- Fix root causes instead of symptoms.
- Optimize for maintainability and clarity over short-term speed.
- If unsure, consult repo-local docs, remaining `.agents/skills/`, and official references; document non-trivial trade-offs.
- Before proposing architecture, check `docs/adr/` for a decision that already covers it. Significant new decisions get a new ADR.
- Typesafety is useful, take advantage of it.
- Don't be scared to propose bold ideas if they can meaningfully and CLEARLY benefit our work
- Testing essential backend behavior is good! However, endless smoke tests, "regression tests" for feature deletions, etc... is BAD. Tests should be ultra concise, focused and meaningful. Prefer very small but essential test coverage that has a clear benefit.
- Adding ultra concise but essential comments to clarify functionality and intended behavior is okay. However, keep comments very concise, essentail, meaningful and easy to read.
- Keep comments and documentation up to date. When making changes, it's important to keep things in sync to prevent future agents from getting confused.
- No `// @ts-ignore`.
- No lint-rule bypassing (`eslint-disable`) without explicit documented approval.
- Do not downgrade or disable checks to "make it pass."
- When extending an existing feature to a new state, audience, or route, identify the current source-of-truth pattern before editing. Match its component ownership, placement logic, accessibility, and interaction model by default.
- Keep future restyling centralized: prefer shared primitives and semantic tokens over hard-coded, call-site-specific styling. Equivalent controls should preserve shared behavior and structure while the visual language evolves.



## Typescript preferences

- `any` is the enemy. Inferred types are our friend. Our systems should adapt to changes, instead of requiring changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casting wrappers.
- Write TypeScript in ways that Matt Pocock and Theo would be proud of.
- If not already specified in project, I generally like to use the following tech: Convex, Tailwind, React, Vite, bun
- When building more complex web and react native apps, I like to pull in Zustand, React Query, Tanstack Start, Workos or Clerk (or better-auth if selfhosting), and ArkType (or zod if perf isn't an issue)



## Commands and local dev

- Verify with `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build:next`.
- `bun run build` **is NOT a build — it deploys to production Convex.** Never run it to verify a change; use `bun run build:next`.



## Match ceremony to the task

- Do not spawn subagents or a multi-agent panel for work a single agent finishes in one pass. Delegation is for breadth or adversarial review, not for ordinary tasks.
- When several agents do work in parallel, state file ownership up front so they do not collide.



## Front-end work

- Don't overly index your changes on one-off component overrides. Most front-end work should change the primitive component when appropriate to keep the design system focused and extendable.
- If there is a opportunity to centralize front-end changes to prevent UI drift between two or more obvious UI surfaces, then take that opportunity and tell me about it so I can review it.
- Information-dense, no decorative card/pill chrome, no light-gray subtitle lines above sections. Minimal copy. No em dashes.
- Avoid continuously repainting CSS animations (pulse, shimmer, blur, spinners); they peg the GPU on high-refresh displays.
- Don't use Computer Use and hijack my computer unless absolutely necessary. Prefer using my authenticated sessions on chrome, using dev tools, etc...



## Database

This project has **no users**. The development database is disposable. Production
Convex can still contain smoke-test or manually created rows, so production
deploy validation treats it as stateful unless explicitly marked disposable.

- Change `convex/schema.ts` directly for development data: add, remove, rename,
retype, or narrow fields as the design needs. For fields that have reached
production, keep removed/narrowed fields optional until production is cleaned
or wiped and the deploy preflight can prove compatibility.
- If existing dev data conflicts with a schema change, wipe it (Convex dashboard
or a one-off `bunx convex run`/clear) and move on. Losing dev data is not a risk.
- Schema and data-model changes are **not** high-risk and require **no** approval
gate while pre-launch.
- The expand/migrate/contract workflow (`docs/convex-migrations.md`), the
migration manifests (`convex/migrations/`), and the schema-guard ceremony are
dormant for non-production pre-launch work. Production deploy preflight and CI
dry-run checks stay active to prevent strict schemas from rejecting existing
production documents. Set `CONVEX_PROD_DB_DISPOSABLE=true` only when the
production data can intentionally be wiped or ignored.
  - `docs/convex-access.md` — **read before querying Convex** (MCP/CLI/dashboard).
  The app's data lives only in the deployment `NEXT_PUBLIC_CONVEX_URL` /
  `CONVEX_DEPLOYMENT` point to; the Convex MCP can silently resolve to a
  different, empty backend. If a read returns `0 users`/`0 chats` for an app in
  active use, the tool is pointed at the wrong deployment — verify against the
  dashboard, don't trust it.

Scope: **the database only.** This does NOT relax working-tree/file hygiene (do
not delete user-owned or untracked files — see "Dirty Worktree And Generated
Files"), secret handling (never log secrets; treat BYOK keys as
encrypted-at-rest), or auth correctness.

When the app gains real users, revert this section and fully re-activate the
migration discipline.

## Correctness-First Escalation

- Use risk-based rigor: keep low-risk tasks lightweight, increase rigor for medium/high-risk tasks.
- Medium/high-risk changes require a brief approach decision before coding (options, trade-offs, chosen approach).
- High-risk triggers include: auth, API contracts, concurrency, billing/payments, and security-critical paths. (Database schema, data model, and migrations are NOT high-risk pre-launch — see "Pre-Launch: The Database Is Disposable".)
- Introducing a new dependency or architectural pattern requires explicit justification and at least one alternative considered.
- Validation depth must scale with risk; do not treat successful compilation as sufficient evidence of correctness.
- For medium/high-risk changes, follow the decision process in this section and document the chosen approach before coding.



## Security

- Never log or expose secrets, tokens, or credentials.
- Treat BYOK/API key data as encrypted-at-rest.



## Git Safety

- Never create branches unless explicitly asked.
- Never force-push to shared branches.
- Avoid destructive git commands unless explicitly requested.



## Dirty Worktree And Generated Files

- Treat all existing modified, deleted, and untracked files as user-owned unless the user explicitly says they are disposable.
- Before running tools that may write files, inspect `git status --short` and note the existing dirty state.
- Do not delete, revert, rewrite, or "clean up" out-of-scope files just to make the final diff look cleaner.
- Never delete untracked files to restore scope. Untracked files are not recoverable from git.
- If accidental out-of-scope edits occur, stop and report the exact paths before attempting repair.



## Other Preferences

- If asked to create a prompt, return it directly in chat unless a file is explicitly requested.
- Do not include timeline or effort estimates unless explicitly requested.
- Do not stage, delete, or normalize unrelated files when making narrow changes.
- If you need to live smoketest or verify changes, always use my authenticated chrome browser, never use your own.

