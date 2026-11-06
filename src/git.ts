import { execFile } from "node:child_process";

export class GitError extends Error {}

interface GitOptions {
  env?: Record<string, string>;
  /** Exit codes that count as success. `git diff --no-index` exits 1 when files differ. */
  okCodes?: number[];
}

function run(cwd: string, args: string[], opts: GitOptions) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd, env: { ...process.env, ...opts.env }, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Runs git and returns stdout, throwing on a non-zero exit. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await run(cwd, args, opts);
  if (!(opts.okCodes ?? [0]).includes(code)) throw new GitError(`git ${args.join(" ")} failed:\n${stderr.trim()}`);
  return stdout;
}

/** Runs git and returns trimmed stdout, or null on a non-zero exit. */
export async function gitMaybe(cwd: string, args: string[], opts: GitOptions = {}): Promise<string | null> {
  const { code, stdout } = await run(cwd, args, opts);
  return code === 0 ? stdout.trim() : null;
}
