import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('./mcp.ts', import.meta.url));

// A live, referenced timer: stands in for any open handle (an lldb child, a Chrome socket).
const holdOpen = 'data:text/javascript,setInterval(() => {}, 1e6)';

async function expectExitOnStdinClose(preload: string[]) {
  const proc = spawn(process.execPath, [...preload, '--import', 'tsx', entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    // Prove the server is up and serving before we hang up on it.
    const reply = new Promise<string>((resolve, reject) => {
      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('\n')) resolve(buf);
      });
      proc.once('exit', (code) => reject(new Error(`exited early: ${code}`)));
    });
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }) + '\n'
    );
    expect(JSON.parse(await reply)).toMatchObject({ id: 1, result: { serverInfo: { name: 'control' } } });

    const exited = once(proc, 'exit');
    proc.stdin.end();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('still running 3s after stdin closed')), 3000)
    );
    const [code] = await Promise.race([exited, timeout]);
    expect(code).toBe(0);
  } finally {
    proc.kill('SIGKILL');
  }
}

describe('mcp entry', () => {
  it('exits when its client closes stdin', () => expectExitOnStdinClose([]), 15000);

  it('exits when stdin closes even with another handle open', () =>
    expectExitOnStdinClose(['--import', holdOpen]), 15000);
});
