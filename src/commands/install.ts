import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { packageRoot, templateDir } from "../lib/paths.js";
import { DEFAULT_IMAGE, readConfig, writeDefaultConfigIfMissing } from "../lib/config.js";
import { assertDockerAvailable, imageExistsLocally, pullImage } from "../lib/docker.js";

export interface InstallOptions {
  projectRoot?: string;
  skipPlaywright?: boolean;
  image?: string;
  skipImage?: boolean;
}

export async function runInstall(opts: InstallOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  await assertDockerAvailable();

  const claudeCmdDir = path.join(projectRoot, ".claude", "commands");
  const opencodeCmdDir = path.join(projectRoot, ".opencode", "command");
  fs.mkdirSync(claudeCmdDir, { recursive: true });
  fs.mkdirSync(opencodeCmdDir, { recursive: true });

  writeCommand(claudeCmdDir, opencodeCmdDir, "rumi");

  writeDefaultConfigIfMissing(projectRoot);

  const image = opts.image ?? readConfig(projectRoot).image;
  if (!opts.skipImage) {
    await ensureImage(image);
  }

  if (opts.skipPlaywright) {
    console.log("↷ skipped playwright-cli skill install");
    return;
  }

  await installPlaywrightSkills(projectRoot, image);
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

async function ensureImage(image: string): Promise<void> {
  if (await imageExistsLocally(image)) {
    console.log(`✔ docker image ${image} present locally`);
    return;
  }
  if (image === DEFAULT_IMAGE) {
    await buildDefaultImage(image);
    return;
  }
  console.log(`→ docker pull ${image}`);
  await pullImage(image);
}

async function buildDefaultImage(image: string): Promise<void> {
  const context = packageRoot();
  const dockerfile = path.join(context, "Dockerfile");
  if (!fs.existsSync(dockerfile)) {
    throw new Error(
      `docker image "${image}" not found locally and no Dockerfile at ${dockerfile}.\n` +
        `This rumi install was packed without build context — install from a clone (\`npm install -g /path/to/rumi\`), or set "image" in rumi/config.json to a published tag.`,
    );
  }
  console.log(`→ docker build -t ${image} ${context}  (first run — ~1.5 GB; downloads Chromium)`);
  const res = await execa("docker", ["build", "-t", image, context], { stdio: "inherit", reject: false });
  if (res.exitCode !== 0) {
    throw new Error(`docker build failed (exit ${res.exitCode})`);
  }
  console.log(`✔ built ${image}`);
}

async function installPlaywrightSkills(projectRoot: string, image: string): Promise<void> {
  console.log("→ running `playwright-cli install --skills=claude` inside the container…");
  const res = await execa(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "playwright-cli",
      "-v",
      `${projectRoot}:/work`,
      "-w",
      "/work",
      image,
      "install",
      "--skills=claude",
    ],
    { reject: false, stdio: "inherit" },
  );
  if (res.exitCode !== 0) {
    console.warn("⚠ playwright-cli install --skills=claude exited non-zero; continuing.");
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
