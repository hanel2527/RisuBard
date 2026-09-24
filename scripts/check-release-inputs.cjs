'use strict';
const fs = require('node:fs');
const path = require('node:path');

function checkReleaseInputs(root, stage) {
    const read = name => fs.readFileSync(path.join(root, name), 'utf8');
    const relative = name => {
        const normalized = name.replace(/\\/g, '/').replace(/\/$/, '');
        if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..') || /[:*?]/.test(normalized)) {
            throw new Error(`Expected a literal relative release input: ${name}`);
        }
        return normalized;
    };
    const patchPaths = text => [...text.matchAll(/:\s*['"]?([^'"\r\n]+\.patch)['"]?\s*$/gm)].map(match => relative(match[1].trim()));
    const patches = [...new Set([...patchPaths(read('pnpm-workspace.yaml')), ...patchPaths(read('pnpm-lock.yaml'))])];
    const inputs = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...patches];
    const workflow = read('.github/workflows/release.yml');
    // Deliberately accept the repository's literal upload path block, not an
    // incomplete YAML/glob interpreter. A format change must update this gate.
    const upload = workflow.match(/name: app-build\s+path: \|\r?\n((?: {12}[^\r\n]+\r?\n)+)/);
    if (!upload) throw new Error('Cannot locate the literal app-build portable path list');
    const uploaded = upload[1].trim().split(/\r?\n/).map(line => relative(line.trim()));
    const docker = read('Dockerfile');
    const install = docker.search(/^RUN .*pnpm install/m);
    if (install < 0) throw new Error('Cannot locate Docker dependency install');
    const copies = [...docker.slice(0, install).matchAll(/^COPY\s+(.+?)\s+(\S+)\s*$/gm)].flatMap(match => {
        const dest = path.posix.normalize(match[2].replace(/^\/app(?:\/|$)/, './')).replace(/\/$/, '');
        return match[1].split(/\s+/).map(source => ({ source: source.replace(/\/$/, ''), dest }));
    });
    const excluded = read('.dockerignore').split(/\r?\n/).map(line => line.trim().replace(/^\//, '').replace(/\/$/, '')).filter(line => line && !line.startsWith('#'));
    for (const input of inputs) {
        if (!fs.statSync(path.join(root, input)).isFile()) throw new Error(`Missing release input: ${input}`);
        if (!uploaded.some(entry => input === entry || input.startsWith(`${entry}/`))) throw new Error(`portable upload omits ${input}`);
        if (!copies.some(({ source, dest }) =>
            (source === '.' && dest === '.') ||
            (input === source && (dest === '.' || dest === input)) ||
            (input.startsWith(`${source}/`) && dest === source))) {
            throw new Error(`Docker omits ${input} before dependency install`);
        }
        if (excluded.some(entry => input === entry || input.startsWith(`${entry}/`))) throw new Error(`dockerignore excludes ${input}`);
    }
    if (stage) {
        fs.mkdirSync(stage); // Never overwrite an existing staging directory.
        for (const input of inputs) {
            const target = path.join(stage, input);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(root, input), target);
        }
        fs.writeFileSync(path.join(stage, '.npmrc'), 'node-linker=hoisted\n');
    }
    return inputs;
}

module.exports = { checkReleaseInputs };
if (require.main === module) {
    try {
        const inputs = checkReleaseInputs(path.resolve(__dirname, '..'), process.argv[2]);
        console.log(`Release dependency inputs verified: ${inputs.length} files`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
