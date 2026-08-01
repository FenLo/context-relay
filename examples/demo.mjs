import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(projectRoot, "bin", "context-relay.mjs");
const workspace = mkdtempSync(join(tmpdir(), "context-relay-demo-"));

function relay(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

try {
  relay("init", "--objective", "Fix OAuth callback without adding Redis");
  relay("turn", "--user", "The callback loops after login");
  relay("constraint", "Do not add Redis");
  relay("decision", "Keep signed-cookie sessions");
  relay("attempt", "Changing SameSite did not fix the loop", "--details", "Reverted");
  writeFileSync(join(workspace, "verify.mjs"), 'console.log("OAuth unit tests pass");\n');
  relay("run", "--", process.execPath, "verify.mjs");
  relay("done", "OAuth unit tests pass", "--evidence", "verify.mjs exited 0");
  relay("next", "Repair the integration-test state fixture");
  relay("turn", "--assistant", "The signed-state path is fixed; integration coverage remains");
  relay("checkpoint");
  process.stdout.write(relay("resume"));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
