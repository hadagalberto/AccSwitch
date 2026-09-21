import readline from 'node:readline';

const ESC = '\u001b';

const c = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  red: `${ESC}[31m`,
};

const CLEAR_LINE = `${ESC}[K`;
const up = (n) => `${ESC}[${n}A`;

export const color = c;

export function paint(text, ...styles) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `${styles.join('')}${text}${c.reset}`;
}

/**
 * Arrow-key single-select. Falls back to a numbered prompt when stdin is not a
 * TTY (piped input, CI) so the CLI stays scriptable.
 *
 * @param {{message: string, choices: Array<{label: string, hint?: string, value: any, disabled?: boolean}>}} options
 * @returns {Promise<any|null>} the chosen value, or null if cancelled
 */
export async function select({ message, choices }) {
  const selectable = choices.filter((choice) => !choice.disabled);
  if (!selectable.length) return null;
  if (!process.stdin.isTTY) return promptByNumber({ message, choices, selectable });

  let index = choices.indexOf(selectable[0]);

  const render = (first) => {
    if (!first) process.stdout.write(up(choices.length + 1));
    process.stdout.write(`${paint('?', c.cyan, c.bold)} ${paint(message, c.bold)}${CLEAR_LINE}\n`);
    choices.forEach((choice, i) => {
      const active = i === index;
      const marker = active ? paint('>', c.cyan) : ' ';
      const label = choice.disabled
        ? paint(choice.label, c.dim)
        : active
          ? paint(choice.label, c.cyan)
          : choice.label;
      const hint = choice.hint ? ` ${paint(choice.hint, c.dim)}` : '';
      process.stdout.write(`${marker} ${label}${hint}${CLEAR_LINE}\n`);
    });
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  render(true);

  return new Promise((resolve) => {
    const move = (step) => {
      let next = index;
      for (let i = 0; i < choices.length; i += 1) {
        next = (next + step + choices.length) % choices.length;
        if (!choices[next].disabled) break;
      }
      index = next;
      render(false);
    };

    const finish = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      process.stdout.write('\n');
      resolve(value);
    };

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j') move(1);
      else if (key.name === 'return' || key.name === 'space') finish(choices[index].value);
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(null);
    };

    process.stdin.on('keypress', onKey);
  });
}

async function promptByNumber({ message, choices, selectable }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(message);
  choices.forEach((choice, i) => {
    if (choice.disabled) console.log(`   - ${choice.label} ${choice.hint ?? ''}`);
    else console.log(`  ${i + 1}) ${choice.label} ${choice.hint ?? ''}`);
  });
  const answer = await rl.question('Number (empty to cancel): ');
  rl.close();
  const picked = choices[Number(answer) - 1];
  if (!picked || picked.disabled) return null;
  return selectable.includes(picked) ? picked.value : null;
}

export async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${paint('?', c.cyan, c.bold)} ${question} `)).trim();
  rl.close();
  return answer || fallback;
}

export async function confirm(question) {
  const answer = (await ask(`${question} [y/N]`)).toLowerCase();
  return answer === 'y' || answer === 'yes' || answer === 's' || answer === 'sim';
}
