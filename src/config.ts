/** Read a required environment variable, or stop with a message that says which one is missing. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new Error(`Set the ${name} environment variable`);
  return v;
}
