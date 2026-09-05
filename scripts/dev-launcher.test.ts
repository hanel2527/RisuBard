import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEV_URL,
  createChildSpecs,
  isRestartKey,
} from './dev-launcher.mjs';

describe('RisuBard development launcher', () => {
  it('starts the web client and a stable Node server from the repository root', () => {
    const specs = createChildSpecs('E:\\RisuBard');

    expect(DEV_URL).toBe('http://127.0.0.1:5174');
    expect(specs).toEqual([
      {
        label: 'SERVER',
        args: ['server/node/server.cjs'],
      },
      {
        label: 'WEB',
        args: ['E:\\RisuBard/node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
      },
    ]);
  });

  it('reserves R as the manual restart key', () => {
    expect(isRestartKey({ name: 'r', ctrl: false })).toBe(true);
    expect(isRestartKey({ name: 'r', ctrl: true })).toBe(false);
  });

  it('keeps the command wrapper repository-relative', () => {
    const wrapperPath = path.join(process.cwd(), 'scripts', 'launch-risubard-dev.cmd');
    const wrapper = readFileSync(wrapperPath, 'utf8');

    expect(wrapper).toContain('cd /d "%~dp0.."');
    expect(wrapper).toContain('node "scripts\\dev-launcher.mjs"');
    expect(wrapper).toContain('\r\n');
    expect(wrapper.replaceAll('\r\n', '')).not.toContain('\n');
  });
});
