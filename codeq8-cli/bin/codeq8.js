#!/usr/bin/env node

import { runCli } from "../dist/cli.js";

const args = process.argv.slice(2);

runCli(args)
  .then((exitCode) => {
    if (Number.isInteger(exitCode)) {
      process.exitCode = exitCode;
    }
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`codeq8: ${message}\n`);
    process.exitCode = 1;
  });
