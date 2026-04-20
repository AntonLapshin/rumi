import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { templateDir } from "../lib/paths.js";
import { writeDefaultConfigIfMissing } from "../lib/config.js";

export interface InstallOptions {
  projectRoot?: string;
  skipPlaywright?: boolean;
}

export async function runInstall(opts: InstallOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  const claudeCmdDir = path.join(projectRoot, ".claude", "commands");
  const opencodeCmdDir = path.join(projectRoot, ".opencode", "command");
  fs.mkdirSync(claudeCmdDir, { recursive: true });
  fs.mkdirSync(opencodeCmdDir, { recursive: true });

  writeCommand(claudeCmdDir, opencodeCmdDir, "rumi");

  writeDefaultConfigIfMissing(projectRoot);
  mergeClaudeSettings(projectRoot);

  if (opts.skipPlaywright) {
    console.log("↷ skipped playwright-cli skill install");
    return;
  }

  await installPlaywrightSkills(projectRoot);
  mirrorSkillToOpencode(projectRoot);
}

function writeCommand(claudeCmdDir: string, opencodeCmdDir: string, name: string): void {
  const claudeBody = fs.readFileSync(path.join(templateDir(), `${name}-claude.md`), "utf8");
  const opencodeBody = fs.readFileSync(path.join(templateDir(), `${name}-opencode.md`), "utf8");
  fs.writeFileSync(path.join(claudeCmdDir, `${name}.md`), claudeBody, "utf8");
  fs.writeFileSync(path.join(opencodeCmdDir, `${name}.md`), opencodeBody, "utf8");
  console.log(`✔ wrote ${path.join(".claude", "commands", `${name}.md`)}`);
  console.log(`✔ wrote ${path.join(".opencode", "command", `${name}.md`)}`);
}

async function installPlaywrightSkills(projectRoot: string): Promise<void> {
  console.log("→ running `playwright-cli install --skills=claude`…");
  const res = await execa("playwright-cli", ["install", "--skills=claude"], {
    cwd: projectRoot,
    stdio: "inherit",
    reject: false,
  });
  if (res.exitCode !== 0) {
    console.warn(
      "⚠ playwright-cli install --skills=claude exited non-zero. " +
        "Ensure `@playwright/cli` is on PATH (`npm install -g @playwright/cli`).",
    );
  }
}

// Deny-list rules the persona prompts used to recite. Pushing these into
// .claude/settings.json means the harness enforces them — the prompt can be
// shorter and smaller models can't violate the rule even if they forget it.
const RUMI_DENY_RULES = [
  "Bash(ls -R:*)",
  "Bash(ls -la:*)",
  "Bash(find . -type:*)",
  "Bash(find .:*)",
  "Bash(tree:*)",
  "Read(**/node_modules/**)",
  "Read(**/dist/**)",
  "Read(**/build/**)",
  "Read(**/.next/**)",
  "Read(**/.turbo/**)",
  "Read(**/coverage/**)",
  "Read(**/*.lock)",
  "Read(**/*.min.*)",
];

function mergeClaudeSettings(projectRoot: string): void {
  const file = path.join(projectRoot, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(
        `⚠ ${path.relative(projectRoot, file)} invalid (${(e as Error).message}); leaving as-is`,
      );
      return;
    }
  }
  const permissions =
    (existing.permissions as Record<string, unknown> | undefined) ?? {};
  const deny = new Set(((permissions.deny as string[] | undefined) ?? []));
  let added = 0;
  for (const rule of RUMI_DENY_RULES) {
    if (!deny.has(rule)) {
      deny.add(rule);
      added++;
    }
  }
  permissions.deny = [...deny];
  existing.permissions = permissions;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
  if (added > 0) {
    console.log(
      `✔ merged ${added} deny rule(s) into ${path.relative(projectRoot, file)}`,
    );
  }
}

function mirrorSkillToOpencode(projectRoot: string): void {
  // playwright-cli writes to .claude/skills/<name> (name varies by version:
  // "playwright" in 0.0.x, "playwright-cli" in 0.1.x). Mirror every subdir we find
  // to .opencode/ so both runners discover the same skills.
  const claudeSkillsDir = path.join(projectRoot, ".claude", "skills");
  if (!fs.existsSync(claudeSkillsDir)) {
    console.warn(`⚠ no ${path.relative(projectRoot, claudeSkillsDir)} after install; skipping mirror`);
    return;
  }
  const entries = fs.readdirSync(claudeSkillsDir, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());
  if (skillDirs.length === 0) {
    console.warn(`⚠ no skills found under ${path.relative(projectRoot, claudeSkillsDir)}; skipping mirror`);
    return;
  }

  // OpenCode discovers skills under .opencode/skills.
  const opencodeTargets = [
    path.join(projectRoot, ".opencode", "skills"),
  ];
  for (const target of opencodeTargets) {
    fs.mkdirSync(target, { recursive: true });
  }

  for (const dir of skillDirs) {
    const src = path.join(claudeSkillsDir, dir.name);
    for (const target of opencodeTargets) {
      const dest = path.join(target, dir.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(src, dest, { recursive: true });
      console.log(`✔ mirrored skill ${dir.name} to ${path.relative(projectRoot, dest)}`);
    }
  }
}
