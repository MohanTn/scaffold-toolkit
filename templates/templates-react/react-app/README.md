# react-app — component-level Vite + React pack

Vite + React 18, plain JS/JSX (no TypeScript, no extra data-fetching library — `fetch` + `useState`/`useEffect`). Built for the `scaffold add` command family: every artifact kind is an opt-in tag, rendered one at a time into the same project.

This pack is **artifact-scoped by design**: its descriptor declares `artifacts` as a required manifest input, so a manifest must always say which artifact tags to render. `scaffold add` compiles that automatically; hand-written manifests pass `--artifact` to `scaffold manifest new`.

Unlike `csharp-enterprise`, this pack has no "entity" concept — it does not generate CRUD feature slices. Each artifact kind is added by name, independent of any other.

## Artifact tags

| Tag | `scaffold add` command | Renders | Injects |
|---|---|---|---|
| `base` (untagged) | part of `scaffold init` | package.json, vite.config.js, index.html, eslint config, App shell + test, Vitest setup, the five barrel files (`components`/`hooks`/`pages`/`context`/`api` index.js) | — |
| `component` | `add component --name <Name>` | component + CSS module + test | `COMPONENT_EXPORTS` (`src/components/index.js`) |
| `hook` | `add hook --name <HookName>` | custom hook + test | `HOOK_EXPORTS` (`src/hooks/index.js`) |
| `page` | `add page --name <Name>` | page component + test | `PAGE_EXPORTS` (`src/pages/index.js`) |
| `context` | `add context --name <Name>` | context provider + consumer hook + test | `CONTEXT_EXPORTS` (`src/context/index.js`) |
| `api-client` | `add api-client --name <Name>` | fetch-based REST client (getAll/getById/create/update/remove) + test | `API_EXPORTS` (`src/api/index.js`) |

## Conventions this pack guarantees

- **Naming**: every `--name` is PascalCase on input. `hook` and `api-client` names are entered PascalCase (e.g. `--name UseToggle`, `--name Products`) and the pack's `camel` Handlebars helper derives the camelCase filename/export (`useToggle.js`, `productsApi.js`) — this keeps the shared `scaffold add` compiler's PascalCase validation uniform across every artifact kind rather than special-casing hook/api naming in the CLI.
- **Barrel exports are append-only**: each artifact kind's file(s) are create-mode (never overwritten), and the corresponding barrel injection appends one export line per name — safe to run repeatedly for different names, and idempotent for the same name.
- **AI_IMPLEMENTATION seams**: `component`, `hook`, `page`, and `context` wrap their generated body in a `required` seam — the shipped placeholder compiles and its own generated test passes (smoke-tests only: "renders"/"returns a defined value"), but the seam is the spot a host agent fills with real behavior. `api-client`'s CRUD methods are fully generated (no seam needed — they're boilerplate REST calls); it carries one optional, non-required seam at the bottom for project-specific requests.
- **No router, no data-fetching library**: pages are plain components registered in a barrel, not wired into a routing table — this pack assumes the host project brings its own router if it needs one. `api-client` uses the global `fetch`, not a caching/query library.

## Build check

`templates/templates-react/tools/validate-build-react-app.mjs` drives the real `scaffold add` commands into a throwaway project and runs `npm install`, `npm run build`, `npm test`, and `npm run lint`. It runs in CI and gates publish.
