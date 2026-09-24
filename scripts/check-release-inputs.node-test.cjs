const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkReleaseInputs } = require('./check-release-inputs.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-inputs-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches', 'Dockerfile', '.dockerignore', '.github/workflows/release.yml']) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.resolve(__dirname, '..', name), target, { recursive: true });
    }
    return root;
}

test('stages the dependency inputs from the actual portable artifact contract', t => {
    const root = fixture(t);
    const stage = path.join(root, 'staged');
    const inputs = checkReleaseInputs(root, stage);
    assert(inputs.includes('pnpm-workspace.yaml'));
    assert(inputs.some(name => name.endsWith('.patch')));
    for (const name of inputs) assert.deepEqual(fs.readFileSync(path.join(stage, name)), fs.readFileSync(path.join(root, name)));
    assert(!fs.existsSync(path.join(stage, 'server')));
    assert.throws(() => checkReleaseInputs(root, stage), /exist/i);
});

test('rejects a patch omitted from the portable upload', t => {
    const root = fixture(t);
    const file = path.join(root, '.github/workflows/release.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^\s+patches\/\r?\n/m, ''));
    assert.throws(() => checkReleaseInputs(root), /portable.*patches/i);
});

test('rejects missing workspace config before the Docker production install', t => {
    const root = fixture(t);
    const file = path.join(root, 'Dockerfile');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('COPY pnpm-workspace.yaml .', ''));
    assert.throws(() => checkReleaseInputs(root), /Docker.*pnpm-workspace/i);
});

test('rejects Docker patches copied only after the first install', t => {
    const root = fixture(t);
    const file = path.join(root, 'Dockerfile');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('COPY patches ./patches', '') + '\nCOPY patches ./patches\n');
    assert.throws(() => checkReleaseInputs(root), /Docker.*patches/i);
});

test('rejects Docker inputs excluded from the build context', t => {
    const root = fixture(t);
    fs.appendFileSync(path.join(root, '.dockerignore'), '\npatches\n');
    assert.throws(() => checkReleaseInputs(root), /dockerignore.*patches/i);
});

test('rejects patches copied into the wrong Docker directory', t => {
    const root = fixture(t);
    const file = path.join(root, 'Dockerfile');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('COPY patches ./patches', 'COPY patches .'));
    assert.throws(() => checkReleaseInputs(root), /Docker.*patches/i);
});
