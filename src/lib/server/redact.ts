export function redactSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.map((item) => item.trim()).filter((item) => item.length >= 4))];
  unique.sort((left, right) => right.length - left.length);
  let next = text;
  for (const secret of unique) {
    next = next.split(secret).join("***");
  }
  next = next.replace(/Bearer\s+\S+/gi, "Bearer ***");
  next = next.replace(/\b(api[_-]?key|authorization)\b\s*[:=]\s*\S+/gi, "$1=***");
  return next;
}

export function collectSecrets(...groups: Array<string | undefined | readonly string[]>): string[] {
  const secrets: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    if (typeof group === "string") secrets.push(group);
    else secrets.push(...group);
  }
  return secrets;
}
