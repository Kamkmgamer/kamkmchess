# Issue tracker

Linear is the canonical tracker for this project.

- Project: [AI Chess MVP](https://linear.app/kamkm/project/ai-chess-mvp-8a102853ce2c), ID `P-KHA-1`
- Approved specification: [KHA-14](https://linear.app/kamkm/issue/KHA-14/agree-on-mvp-acceptance-criteria-and-the-specification-handoff)
- Application foundation: [KHA-26](https://linear.app/kamkm/issue/KHA-26/establish-the-reacttypescript-application-and-build-checks)

The owner amended [the architecture decision](https://linear.app/kamkm/issue/KHA-13/choose-the-application-architecture-and-data-boundaries), comment `7e9599bd-2143-49fa-b139-8018a25cbeb7`: React/TypeScript/Vite and browser-owned chess rules, clocks, direct provider calls and adjudication remain; Vercel replaces Cloudflare, a Go API with PostgreSQL replaces Supabase storage, and Clerk Auth replaces Supabase Auth. Google sign-in uses Clerk. The API enforces identity and storage ordering but never decides chess legality or receives AI credentials. Supabase migrations and tests remain historical evidence. The PostgreSQL provider remains unselected.

The specification, acceptance matrix and implementation roadmap in this repository are snapshots for review. Check Linear for current decisions and ticket status. This repository does not include private tracker exports or raw research evidence.
