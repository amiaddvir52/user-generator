import readline from "node:readline/promises";

export const confirmPrompt = async ({
  message,
  defaultNo = true
}: {
  message: string;
  defaultNo?: boolean;
}) => {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const suffix = defaultNo ? " [y/N] " : " [Y/n] ";
  const answer = (await rl.question(`${message}${suffix}`)).trim().toLowerCase();
  await rl.close();

  if (answer.length === 0) {
    return !defaultNo;
  }

  return answer === "y" || answer === "yes";
};

export const chooseFromCandidates = async ({
  options,
  message
}: {
  options: string[];
  message: string;
}) => {
  if (!process.stdin.isTTY) {
    return 0;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  process.stdout.write(`${message}\n`);
  options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option}\n`);
  });

  const answer = await rl.question("Choose a number: ");
  await rl.close();

  const selected = Number(answer);
  if (Number.isNaN(selected) || selected < 1 || selected > options.length) {
    return 0;
  }

  return selected - 1;
};

