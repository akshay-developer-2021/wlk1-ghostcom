import { Page } from '@playwright/test';

export interface LogEntry {
  ts: string;
  browser: 'alice' | 'bob';
  type: 'console' | 'pageerror' | 'mesh';
  level: 'sys' | 'tx' | 'rx' | 'warn' | 'info';
  text: string;
}

/** Collects console + pageerror + app traffic logs.
    Pushes into the caller-provided array so fixtures can expose the
    same live list the test asserts against. */
export class LogCollector {
  constructor(private logs: LogEntry[] = []) {}

  attach(page: Page, browserId: 'alice' | 'bob'): void {
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('[WLK1]')) {
        /* format: '[WLK1] HH:MM:SS <prefix> <msg>' */
        const parts = text.split(' ');
        const prefix = parts[2] ?? '··';
        const level: LogEntry['level'] =
          prefix === '▲TX' ? 'tx' : prefix === '▼RX' ? 'rx' : prefix === '!!' ? 'warn' : 'sys';
        this.logs.push({
          ts: new Date().toISOString(),
          browser: browserId,
          type: 'mesh',
          level,
          text: parts.slice(3).join(' '),
        });
        return;
      }
      this.logs.push({
        ts: new Date().toISOString(),
        browser: browserId,
        type: 'console',
        level: msg.type() as LogEntry['level'],
        text,
      });
    });

    page.on('pageerror', (err) => {
      this.logs.push({
        ts: new Date().toISOString(),
        browser: browserId,
        type: 'pageerror',
        level: 'warn',
        text: `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 5).join('\n')}`,
      });
    });
  }

  getLogs(): ReadonlyArray<LogEntry> { return this.logs; }
  count(): number { return this.logs.length; }
  clear(): void { this.logs.length = 0; }

  async writeLogFile(testInfo: { title: string }): Promise<string> {
    const outputDir = 'test-results/logs';
    const { mkdirSync, writeFileSync } = await import('fs');
    const { join } = await import('path');

    mkdirSync(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${testInfo.title.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}.jsonl`;
    const filepath = join(outputDir, filename);
    writeFileSync(filepath, this.logs.map((l) => JSON.stringify(l)).join('\n') + '\n');
    console.log(`[Logs] Written ${this.logs.length} entries to ${filepath}`);
    return filepath;
  }
}
