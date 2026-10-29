# Decision tree story helpers

This folder holds plain TypeScript helpers for decision-tree design previews. The earlier animated page and its rendered output are not part of the public harness.

What is left are plain TypeScript helpers with no Remotion or React dependency. They stay because the ten decision tree designs at `/tree-designs` (`designs/src/app.tsx` and `designs/src/types.ts`) import them:

- `src/tree-data.ts`: the real tree (`src/decision-tree/full-tree.json`), bundled at build time. Rebuild the designs page (`pnpm build:designs`) after the tree changes.
- `src/stories/plain-words.ts`: plain titles for every step, answer and ending; stage names.
- `src/stories/walk.ts`: tree to steps. `buildWalk` checks an example call turn by turn against the tree (wrong node, missing answer, wrong ending all refuse) and folds the follow-up answer lists (`*_more2`) into their step. `walkFromRecord` makes the same steps from a harness record, read-only, without the lead's name.
- `src/stories/examples.ts`: the four example calls.
- `src/stories/lights.ts`: traffic lights by where a step or answer heads.

Checks: `pnpm typecheck` includes these files (`tsc -p lab/tsconfig.json`), and `tests/lab/walk.test.ts` runs every example call over the real tree.
