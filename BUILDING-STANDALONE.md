# Building the standalone language server

The server normally runs as `node angelscript-language-server.js --stdio`, which needs Node.js on
the user's machine. The standalone build removes that need: it embeds the bundled server in a copy
of the Node binary as a [single executable application](https://nodejs.org/api/single-executable-applications.html)
(SEA). The result speaks LSP over stdio exactly like the bundle, so an editor plugin launches it as

```
angel-lsp-server-<platform>-<arch>[.exe] --stdio
```

## Build on your machine

Needs Node 24 LTS (the Node that runs the build is the runtime that gets embedded) and the server's
dev dependencies (`esbuild`, `postject`, pinned in `server/package.json`).

```
npm ci
npm ci --prefix server
npm run standalone --prefix server
```

`npm run standalone` type-checks, then runs `server/build-standalone.mjs`, which:

1. bundles `server/src/server.ts` into one CommonJS file with esbuild (a SEA can only `require`
   Node built-ins, so every npm dependency is inlined);
2. writes the SEA blob with `node --experimental-sea-config` (V8 code cache on; pass
   `--no-code-cache` to turn it off);
3. copies the running `node` binary, injects the blob with `postject`, and on macOS re-signs it
   ad hoc (`codesign --sign -`), which Apple Silicon requires;
4. writes `THIRD-PARTY-NOTICES.txt` (angel-lsp, every inlined npm package, and Node's own LICENSE);
5. starts the executable, sends `initialize`, and fails unless it answers with the server's
   capabilities.

Output in `server/dist/`: `angel-lsp-server-<platform>-<arch>[.exe]`, its `.sha256`, and
`THIRD-PARTY-NOTICES.txt`. `server/dist/` is git-ignored.

## Per-OS commands (what the release workflow runs)

There is no cross-compiling: each OS builds its own executable with its own Node, because the
code cache ties the blob to the Node version and platform, and macOS signing needs `codesign`.
`.github/workflows/standalone-release.yml` runs the same three commands on every runner:

| Target | GitHub runner | Commands |
| --- | --- | --- |
| Windows x64 | `windows-latest` | `npm ci`, `npm ci --prefix server`, `npm run standalone --prefix server` |
| macOS arm64 | `macos-15` | same |
| macOS x64 | `macos-15-intel` | same |
| Linux x64 | `ubuntu-24.04` | same |

The workflow is `workflow_dispatch` only. With a `tag` input it attaches one `.tar.gz` per target
(executable, checksum, notices) to a draft release; without one it only uploads build artifacts.

## Numbers (Windows x64, Node 24.20.0)

- Size: 89.7 MiB (94,054,400 bytes); about 33 MiB gzipped. Almost all of it is Node itself; the
  server blob adds well under 1 MiB.
- Time to the `initialize` response, median of 15 warm runs: 53-56 ms for the executable, 59 ms for
  `node angelscript-language-server.js`. The first launch of a freshly written executable took
  about 0.6 s on Windows, which looks like the antivirus scan of a new unsigned binary.

## Shipping notes

- **Notices.** Redistribute `THIRD-PARTY-NOTICES.txt` with the executable. It holds the MIT
  license of angel-lsp, the MIT licenses of `vscode-languageserver`, `vscode-languageserver-protocol`,
  `vscode-languageserver-types`, `vscode-languageserver-textdocument`, `vscode-jsonrpc`,
  `brace-expansion` and `balanced-match`, the Blue Oak Model License 1.0.0 of `minimatch`, and Node's
  LICENSE (MIT for Node, plus the licenses of the V8, libuv, ICU, OpenSSL, llhttp and other
  components compiled into the Node binary).
- **Signing.** Injection invalidates the Node Foundation's Authenticode signature on Windows (postject
  warns "The signature seems corrupted!"; the binary runs). Sign the release executable with your own
  certificate to avoid SmartScreen and antivirus friction. On macOS the ad-hoc signature runs on the
  machine that unpacks it; a Developer ID signature plus notarization is needed if users download the
  executable through a browser.
- **Executable bit.** A plugin that unpacks the executable from a zip must set it executable on macOS
  and Linux before launching it.
- **Node updates.** Node 25.5 and later can build a SEA in one step (`node --build-sea`) without
  postject. Moving to it is a later simplification, not needed on Node 24.
