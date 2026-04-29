const TOKEN_CHAR_PATTERN = /[a-z0-9_-]/;

const isTokenBoundary = (value: string, index: number) =>
  index < 0 || index >= value.length || !TOKEN_CHAR_PATTERN.test(value[index] ?? "");

const isSlashDisjunctionBoundary = ({
  value,
  start,
  end
}: {
  value: string;
  start: number;
  end: number;
}) => {
  let left = start - 1;
  while (left >= 0 && /\s/.test(value[left] ?? "")) {
    left -= 1;
  }

  if ((value[left] ?? "") === "/") {
    return true;
  }

  let right = end;
  while (right < value.length && /\s/.test(value[right] ?? "")) {
    right += 1;
  }

  return (value[right] ?? "") === "/";
};

export const hasStandaloneKeyword = (
  input: string,
  keyword: string,
  options?: {
    ignoreSlashDisjunction?: boolean;
  }
) => {
  const normalizedInput = input.toLowerCase();
  const normalizedKeyword = keyword.toLowerCase().trim();
  if (normalizedKeyword.length === 0) {
    return false;
  }

  let cursor = normalizedInput.indexOf(normalizedKeyword);
  while (cursor !== -1) {
    const start = cursor;
    const end = start + normalizedKeyword.length;
    const hasBoundaries = isTokenBoundary(normalizedInput, start - 1) && isTokenBoundary(normalizedInput, end);
    const ignoreSlashDisjunction = options?.ignoreSlashDisjunction ?? true;
    const disjunctionMatch = ignoreSlashDisjunction
      ? isSlashDisjunctionBoundary({
          value: normalizedInput,
          start,
          end
        })
      : false;

    if (hasBoundaries && !disjunctionMatch) {
      return true;
    }

    cursor = normalizedInput.indexOf(normalizedKeyword, cursor + normalizedKeyword.length);
  }

  return false;
};

export const firstMatchingKeyword = (
  input: string,
  candidates: string[],
  options?: {
    ignoreSlashDisjunction?: boolean;
  }
) =>
  candidates.find((candidate) =>
    hasStandaloneKeyword(input, candidate, {
      ignoreSlashDisjunction: options?.ignoreSlashDisjunction
    })
  );
