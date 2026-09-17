// Shared password-input helpers for the staff CLI scripts (create-staff.js,
// reset-staff-password.js). Precedence: --password-stdin, then
// STAFF_INITIAL_PASSWORD env, then an interactive masked prompt (asked
// twice). A password is never echoed and never logged.
import readline from 'node:readline';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'password-stdin') {
      args.passwordStdin = true;
    } else {
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function readLineFromStdin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

function promptMasked(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = () => {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      rl.output.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (value) => {
      process.stdin.removeListener('data', onData);
      rl.output.write('\n');
      rl.close();
      resolve(value);
    });
  });
}

/**
 * @param {object} args parsed by parseArgs
 * @param {object} [opts]
 * @param {string} [opts.envVar='STAFF_INITIAL_PASSWORD']
 * @param {string} [opts.prompt='New staff password: ']
 */
export async function resolvePassword(args, { envVar = 'STAFF_INITIAL_PASSWORD', prompt = 'New staff password: ' } = {}) {
  if (args.passwordStdin) {
    return (await readLineFromStdin()).replace(/\r$/, '');
  }
  if (process.env[envVar]) {
    return process.env[envVar];
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `No password source. Use --password-stdin, set ${envVar}, or run in an interactive terminal.`
    );
  }
  const first = await promptMasked(prompt);
  const second = await promptMasked('Confirm password: ');
  if (first !== second) {
    throw new Error('Passwords did not match.');
  }
  return first;
}
