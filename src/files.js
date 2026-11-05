// Where output goes. Mock state is written into the LearnLoop repository's
// data/seed/ (it is the app's initial state); logs stay in this repository.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEARNLOOP_REPO = path.resolve(process.env.LEARNLOOP_REPO ?? path.join(TOOLS_ROOT, '../LearnLoop'));
export const DATA_DIR = path.join(LEARNLOOP_REPO, 'data/seed');
export const OUT_DIR = path.join(TOOLS_ROOT, 'out');

/** Arrays are written one record per line, which keeps diffs readable. */
export function formatJson(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]\n' : `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]\n`;
  }
  const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${formatJson(v).trimEnd()}`);
  return `{\n${entries.join(',\n')}\n}\n`;
}

export async function writeData(data, dir = DATA_DIR) {
  await mkdir(dir, { recursive: true });
  for (const [domain, value] of Object.entries(data)) {
    await writeFile(path.join(dir, `${domain}.json`), formatJson(value));
  }
}

export async function writeLogs({ appLogs, cloudfront }, dir = OUT_DIR) {
  await rm(path.join(dir, 'app-logs'), { recursive: true, force: true });
  await rm(path.join(dir, 'cloudfront'), { recursive: true, force: true });
  for (const [key, body] of [...appLogs, ...cloudfront]) {
    const file = path.join(dir, key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
}
