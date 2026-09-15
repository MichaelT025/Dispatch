#!/usr/bin/env node
import { formatTerminalHelp } from '../extensions/piastra/help.mjs';

// Help is available without loading Pi, credentials, extensions, or a workspace.
// Runtime/bootstrap/setup modes will be added by the separate packaging phase.
const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  process.stdout.write(formatTerminalHelp() + '\n');
} else {
  process.stderr.write('This Dispatch entry point currently provides help only.\n');
  process.stderr.write('Setup and CLI/WebUI launch modes are not available yet. Run dispatch --help.\n');
  process.exitCode = 2;
}
