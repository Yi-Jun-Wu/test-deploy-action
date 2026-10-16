/**
 * Public library entrypoint.
 *
 * Re-exports the pieces intended for external consumption:
 *
 *   - {@link deploy} and its option/result types (`./deploy.ts`), the
 *     high-level GitHub Pages deployment routine.
 *   - The artifact primitives (`./artifact-minify.ts`): `uploadArtifact`,
 *     `deleteArtifact`, `deleteSpecificArtifact` and their config types.
 *   - The runner helpers (`./core.ts`): inputs/outputs, workflow commands and
 *     OIDC token retrieval.
 *
 * Everything is dependency-free and can be imported directly, e.g.
 * `import { deploy } from "./src/index.ts"`.
 */

export * from "./deploy.ts";
export * from "./artifact-minify.ts";
export * from "./core.ts";
