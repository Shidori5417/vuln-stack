import { runCli, programName } from './program.js';

const code = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
  prog: programName(process.argv[1]),
});
process.exitCode = code;
