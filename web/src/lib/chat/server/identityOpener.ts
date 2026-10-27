// Does an answer OPEN by stating what it is? (CUR-1430)
//
// The detector itself lives in identityOpenerCore.mjs so the runtime (textGeneration/index.ts) and a
// standalone script with no TS loader (scripts/language-turn-probe.mjs, CUR-1442) share one
// definition — same split as guardPolicy.ts/guardPolicyCore.mjs. This file is a thin re-export, kept
// so existing extension-less imports (`./identityOpener`, `../identityOpener`) keep resolving
// (CUR-1457: a detector split into two copies is two definitions of "opens with identity"). Named
// with a `Core` suffix, not identityOpener.mjs, so the extensionless import here stays unambiguous
// rather than colliding with this file's own name — a same-named sibling made knip treat this file as
// unreachable dead code. No `IdentityOpenerVerdict` type export here: the .mjs's own JSDoc typedef
// covers it, and nothing outside this file imported the TS type by name.

export { detectIdentityOpener } from "./identityOpenerCore.mjs";
