// Builds a standalone AngelScript language server executable for the current OS and CPU:
// the server bundled by esbuild, embedded in a copy of the running Node binary as a
// single executable application (https://nodejs.org/api/single-executable-applications.html).
//
// Usage (from server/, after `npm ci`):  node build-standalone.mjs [--no-code-cache] [--skip-smoke]
// Output: server/dist/angel-lsp-server-<platform>-<arch>[.exe] and a .sha256 beside it.
// The Node that runs this script is the runtime that gets embedded, so pin it (Node 24 LTS).

import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(serverDir, 'dist');
const buildDir = path.join(distDir, 'build');
const args = new Set(process.argv.slice(2));
const useCodeCache = !args.has('--no-code-cache');

const exeName = `angel-lsp-server-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const exePath = path.join(distDir, exeName);
const bundlePath = path.join(buildDir, 'angelscript-language-server.js');
const blobPath = path.join(buildDir, 'sea-prep.blob');
const seaConfigPath = path.join(buildDir, 'sea-config.json');
const noticesPath = path.join(distDir, 'THIRD-PARTY-NOTICES.txt');

// The fuse string Node looks for to tell a plain binary from one carrying an app blob.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) { console.log(`[build-standalone] ${msg}`); }
function run(cmd, cmdArgs) { execFileSync(cmd, cmdArgs, {stdio: 'inherit'}); }
function tryRun(cmd, cmdArgs) {
    try { execFileSync(cmd, cmdArgs, {stdio: 'inherit'}); return true; } catch { return false; }
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) throw new Error(`Node ${process.versions.node} has no single executable application support; use Node 24 LTS.`);

fs.mkdirSync(buildDir, {recursive: true});

step(`bundling src/server.ts with esbuild`);
const {metafile} = await require('esbuild').build({
    entryPoints: [path.join(serverDir, 'src', 'server.ts')],
    outfile: bundlePath,
    bundle: true,
    minify: true,
    platform: 'node',
    // A SEA main script is CommonJS and can only require built-in modules, so everything else is inlined.
    format: 'cjs',
    target: `node${major}`,
    logLevel: 'warning',
    metafile: true,
});

step(`writing the SEA blob (code cache ${useCodeCache ? 'on' : 'off'})`);
fs.writeFileSync(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // V8 code cache ties the blob to this Node version and platform; fine because each OS builds its own.
    useCodeCache,
}, null, 4));
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

step(`copying ${process.execPath} -> ${exePath}`);
fs.rmSync(exePath, {force: true});
fs.copyFileSync(process.execPath, exePath);
fs.chmodSync(exePath, 0o755);

if (process.platform === 'darwin') {
    run('codesign', ['--remove-signature', exePath]);
} else if (process.platform === 'win32') {
    // The copied node.exe carries Node's Authenticode signature, which injection invalidates.
    // Removing it is optional (the binary runs either way); a release signs the result with its own certificate.
    if (!tryRun('signtool', ['remove', '/s', exePath])) step('signtool not found; leaving the stale Node signature in place');
}

step('injecting the blob with postject');
const postjectCli = path.join(path.dirname(require.resolve('postject/package.json')), 'dist', 'cli.js');
const injectArgs = [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, injectArgs);

if (process.platform === 'darwin') run('codesign', ['--sign', '-', exePath]); // ad-hoc; arm64 refuses unsigned code

step('writing third-party notices');
fs.writeFileSync(noticesPath, await thirdPartyNotices(metafile));

const bytes = fs.readFileSync(exePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(`${exePath}.sha256`, `${sha256}  ${exeName}\n`);
step(`built ${exePath} (${(bytes.length / 1048576).toFixed(1)} MiB, sha256 ${sha256})`);

if (!args.has('--skip-smoke')) {
    const ms = await smokeTest(exePath);
    step(`smoke test passed: initialize answered in ${ms.toFixed(0)} ms`);
}

// The licenses a redistributed executable must carry: angel-lsp itself, every npm package esbuild
// inlined into the bundle, and the embedded Node runtime (whose LICENSE also covers V8, libuv, ICU,
// OpenSSL and the rest of Node's bundled dependencies).
async function thirdPartyNotices(meta) {
    const sections = [];
    const rule = '='.repeat(78);
    const add = (name, license, text) => sections.push(`${rule}\n${name} (${license})\n${rule}\n${text.trim()}\n`);
    const repoDir = path.join(serverDir, '..');
    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    add(`angel-lsp ${rootPkg.version}`, rootPkg.license, fs.readFileSync(path.join(repoDir, 'LICENSE'), 'utf8'));

    const pkgDirs = new Set();
    for (const input of Object.keys(meta.inputs)) {
        const m = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input);
        if (m) pkgDirs.add(path.resolve(serverDir, m[1]));
    }
    for (const dir of [...pkgDirs].sort()) {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const file = fs.readdirSync(dir).find(n => /^(licen[cs]e|copying)(\.|$)/i.test(n));
        if (!file) throw new Error(`${pkg.name} has no license file to redistribute`);
        add(`${pkg.name} ${pkg.version}`, pkg.license, fs.readFileSync(path.join(dir, file), 'utf8'));
    }

    // Official archives ship LICENSE beside (Windows zip) or above (bin/) the binary; the Windows MSI omits it.
    const nodeDir = path.dirname(process.execPath);
    const local = [path.join(nodeDir, 'LICENSE'), path.join(nodeDir, '..', 'LICENSE')].find(p => fs.existsSync(p));
    let nodeLicense;
    if (local) {
        nodeLicense = fs.readFileSync(local, 'utf8');
    } else {
        const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`could not fetch the Node license from ${url}: ${res.status}`);
        nodeLicense = await res.text();
    }
    add(`Node.js ${process.version} (embedded runtime)`, 'MIT, plus the licenses of its bundled dependencies', nodeLicense);
    return sections.join('\n');
}

// Starts the executable over stdio, sends initialize, and checks the reply advertises semantic tokens.
function smokeTest(exe) {
    return new Promise((resolve, reject) => {
        const t0 = performance.now();
        const proc = spawn(exe, ['--stdio'], {stdio: ['pipe', 'pipe', 'inherit']});
        const timer = setTimeout(() => { proc.kill(); reject(new Error('no initialize response within 20 s')); }, 20000);
        let buf = Buffer.alloc(0);
        proc.on('error', reject);
        proc.stdout.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);
            const sep = buf.indexOf('\r\n\r\n');
            if (sep < 0) return;
            const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
            if (buf.length < sep + 4 + len) return;
            const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
            const ms = performance.now() - t0;
            clearTimeout(timer);
            proc.kill();
            if (msg.id === 1 && msg.result?.capabilities?.semanticTokensProvider) resolve(ms);
            else reject(new Error(`unexpected first message: ${JSON.stringify(msg).slice(0, 300)}`));
        });
        const body = Buffer.from(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {processId: process.pid, rootUri: null, capabilities: {}},
        }), 'utf8');
        proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        proc.stdin.write(body);
    });
}
