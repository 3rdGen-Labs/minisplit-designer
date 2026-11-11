# Mini-Split Designer

This repository is public and open source (MIT-0). Everything committed, pushed, or written in an issue or pull request is published to the world and stays in Git history.

## Treat it as open source

- Follow `CONTRIBUTING.md` and `LICENSE_SCOPE.md`.
- Never commit secrets, API keys, `.env` files, deployment metadata, real customer names, addresses, or project files. Fixtures and examples use invented customer information.
- Never commit decompiled source, proprietary installers or libraries, database dumps, raw manufacturer extracts, or copied manufacturer descriptions or images. Unit artwork comes from the project's own generators (`design/`).
- Keep private notes, internal business details, and links to private systems out of code, comments, docs, commit messages, and PR text.
- Calculation changes cite a public manufacturer reference (document, revision, page) and add a focused regression test.
- Keep the independent-tool and verification notices accurate. Mitsubishi Electric names identify equipment only.
- Branding lives in `app/src/lib/site.ts`. Keep it replaceable: no hard-coded business names or logos elsewhere.
- The app stores nothing on the server. The open project lives in the browser's localStorage, in a project file the user saves, or with the host page when embedded (`app/src/lib/embed.ts`); PDF and MCP links carry their data in the URL.

## Before every pull request

Run from `app/` and make sure all pass:

1. `pnpm test`
2. `pnpm lint` (0 errors; report existing warnings separately from new ones)
3. `pnpm build`

Then review the full diff (`git diff main...HEAD`) for anything private before pushing.

## Pull request etiquette

- One topic per branch, branched from an up-to-date `main`. Never push to `main` directly.
- PR description: what was wrong or missing, what changed, and the checks run with their results. Link related issues and PRs.
- Update the README and `docs/` when behavior, routes, MCP tools, or configuration change.
- Wait for the Vercel preview check to pass before merging. Squash-merge with the PR number in the title, then delete the branch.
- After merging, confirm the change works on production (designer.3rdgen.io).
