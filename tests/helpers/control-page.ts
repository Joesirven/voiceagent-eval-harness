/** The built control page: its HTML plus its script text, for tests that check what the page contains. */
export async function controlPageBundle(base: string, fetcher: typeof fetch = fetch): Promise<string> {
  const html = await (await fetcher(base + "/")).text();
  const script = /src="(\/assets\/[\w.-]+\.js)"/.exec(html)?.[1];
  if (!script) throw new Error("the control page has no script; run pnpm build:web");
  return html + (await (await fetcher(base + script)).text());
}
