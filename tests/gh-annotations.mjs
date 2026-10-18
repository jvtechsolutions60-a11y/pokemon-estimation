// node:test reporter that turns each failed test into a GitHub annotation,
// so failures show on the run page without opening the logs.
export default async function* annotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail' || event.data.details?.type === 'suite') continue;
    const err = event.data.details?.error;
    const cause = err?.cause ?? err;
    const message = String(cause?.message ?? cause ?? 'échec').replace(/\r?\n/g, '%0A').slice(0, 900);
    yield `::error title=${event.data.name.replace(/[,:]/g, ' ')}::${message}\n`;
  }
}
