import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "src", "context-relay.mjs");
const targets = [
  resolve(projectRoot, "bin", "context-relay.mjs"),
  resolve(
    projectRoot,
    "adapters",
    "codex",
    "context-relay",
    "scripts",
    "context-relay.mjs",
  ),
];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`Built ${target}`);
}
