/**
 * Test support: a throwaway headless Chrome and a local page server, for the
 * integration tests of the chrome tool. Not part of the tool.
 *
 * The profile is a fresh temp directory and the debug port is chosen by
 * Chrome (--remote-debugging-port=0) and read back from DevToolsActivePort,
 * so tests never touch the user's browser or collide on a port.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const chromeAvailable = existsSync(CHROME_PATH);

export interface TestBrowser {
  port: number;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchTestBrowser(): Promise<TestBrowser> {
  const dir = mkdtempSync(join(tmpdir(), 'control-test-chrome-'));
  const proc = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1000,800',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let spawnError: Error | null = null;
  proc.once('error', (e) => {
    spawnError = e;
  });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const close = async () => {
    // A spawn that failed has no pid and never exits; a live process must be gone before its
    // profile is deleted, and if it will not die the profile is left in place rather than raced.
    if (proc.pid !== undefined) {
      proc.kill('SIGKILL');
      const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!gone) throw new Error(`Chrome (pid ${proc.pid}) did not exit; left ${dir} in place`);
    }
    rmSync(dir, { recursive: true, force: true });
  };

  const portFile = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    if (spawnError) {
      await close();
      throw new Error(`Could not start Chrome at ${CHROME_PATH}: ${(spawnError as Error).message}`);
    }
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return { port, close };
    }
    await sleep(150);
  }
  await close();
  throw new Error('Headless Chrome did not report a debug port within 15s');
}

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Serve one HTML page on a random localhost port. */
export async function servePage(html: string): Promise<TestServer> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
