import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = resolve(projectRoot, "adapters", "codex", "context-relay", "SKILL.md");
const content = readFileSync(skillPath, "utf8").replaceAll("\r\n", "\n");
const match = content.match(/^---\n([\s\S]*?)\n---/);

if (!match) throw new Error("SKILL.md has invalid YAML frontmatter.");

const frontmatter = Object.fromEntries(
  match[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
);

const keys = Object.keys(frontmatter);
if (keys.join(",") !== "name,description") {
  throw new Error(`SKILL.md frontmatter must contain only name and description; found ${keys.join(", ")}.`);
}
if (!/^[a-z0-9-]+$/.test(frontmatter.name)) throw new Error("Skill name is not hyphen-case.");
if (
  frontmatter.name.length > 64 ||
  frontmatter.name.startsWith("-") ||
  frontmatter.name.endsWith("-") ||
  frontmatter.name.includes("--")
) {
  throw new Error("Skill name violates naming constraints.");
}
if (!frontmatter.description || frontmatter.description.length > 1024) {
  throw new Error("Skill description is missing or longer than 1024 characters.");
}
if (/[<>]/.test(frontmatter.description)) {
  throw new Error("Skill description contains a forbidden angle bracket.");
}

console.log("Skill is valid!");
