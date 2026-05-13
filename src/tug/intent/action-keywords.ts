export const CANONICAL_ACTIONS = new Set([
  "activate",
  "cancel",
  "convert",
  "create",
  "deactivate",
  "delete",
  "downgrade",
  "enroll",
  "migrate",
  "provision",
  "renew",
  "resubscribe",
  "signup",
  "subscribe",
  "terminate",
  "unsubscribe",
  "upgrade"
]);

const ACTION_SYNONYMS: Record<string, string> = {
  add: "create",
  make: "create",
  generate: "create",
  build: "create",
  remove: "delete",
  drop: "delete",
  destroy: "delete",
  register: "signup",
  enable: "activate",
  disable: "deactivate",
  install: "provision",
  setup: "provision",
  configure: "provision",
  deploy: "provision",
  switch: "migrate",
  attach: "subscribe",
  detach: "unsubscribe"
};

const stripSuffix = (token: string): string[] => {
  const variants: string[] = [];
  if (token.endsWith("ing") && token.length > 4) {
    const stem = token.slice(0, -3);
    variants.push(stem, `${stem}e`);
  }
  if (token.endsWith("ed") && token.length > 3) {
    const stem = token.slice(0, -2);
    variants.push(stem, `${stem}e`);
  }
  if (token.endsWith("es") && token.length > 3) {
    variants.push(token.slice(0, -2), token.slice(0, -1));
  }
  if (token.endsWith("s") && token.length > 2) {
    variants.push(token.slice(0, -1));
  }
  return variants;
};

export const canonicalizeAction = (rawToken: string): string | undefined => {
  const token = rawToken.toLowerCase().replace(/^@/, "").trim();
  if (!token) {
    return undefined;
  }

  if (CANONICAL_ACTIONS.has(token)) {
    return token;
  }
  if (ACTION_SYNONYMS[token]) {
    return ACTION_SYNONYMS[token];
  }

  for (const variant of stripSuffix(token)) {
    if (CANONICAL_ACTIONS.has(variant)) {
      return variant;
    }
    if (ACTION_SYNONYMS[variant]) {
      return ACTION_SYNONYMS[variant];
    }
  }

  return undefined;
};

export const isActionKeyword = (rawToken: string): boolean =>
  canonicalizeAction(rawToken) !== undefined;
