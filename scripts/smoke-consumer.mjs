import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = path.join(rootDir, ".tmp", "consumer-smoke");
const exampleDir = path.join(rootDir, "examples", "vite-react");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit"
  });
}

rmSync(tempDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

run(npmCommand, ["run", "build"], rootDir);

const packOutput = execFileSync(
  npmCommand,
  ["pack", "--json", "--pack-destination", tempDir],
  {
    cwd: rootDir,
    encoding: "utf8"
  }
);

const packed = JSON.parse(packOutput);
const tarballPath = path.join(tempDir, packed[0].filename);

run(npmCommand, ["install", "--package-lock=false"], exampleDir);
run(npmCommand, ["install", "--no-save", "--package-lock=false", tarballPath], exampleDir);
run(npmCommand, ["run", "typecheck"], exampleDir);
run(npmCommand, ["run", "build"], exampleDir);
