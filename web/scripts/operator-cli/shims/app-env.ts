// $app/env for an operator CLI run with plain node: never the dev server, never mid-build, never a browser.
export const dev = false;
export const building = false;
export const browser = false;
export const version = process.env.GIT_SHA ?? "";
