# LLMA4OpenMP-Plus

VS Code extension for C/C++ OpenMP parallelization with static analysis, configurable LLM generation and semantic review, and compiler/runtime feedback for iterative repair.

Developed upon [RussellCanfield/wingman-ai](https://github.com/RussellCanfield/wingman-ai).

## Build and run

Requires Node.js 18 or later, npm, and VS Code 1.87 or later.

```sh
npm ci
npm run typecheck
npm run compile
```

Open this directory in VS Code and press F5 to launch the extension development host. Configure `VscOMP.Provider` and its Ollama or OpenAI-compatible endpoint in VS Code settings. Select a C/C++ loop, then use the VscOMP panel to parallelize it. Set `VscOMP.Reviewer.apiKey`, `apiEndpoint`, and `model` to enable the separately configured semantic reviewer. Keep credentials in local VS Code settings.

The C/C++ Tree-sitter grammars and runtime WASM files in `src/.wasm/` are required runtime assets and are included. `npm run package` builds production assets; it does not create a VSIX.

## Source layout

- `src/providers/`: VS Code integration and static analysis.
- `src/service/`: model providers, semantic review, iterative repair, and external validation.
- `src/types/`: shared configuration and result types.
- `src/webview-ui/` and `src/configview/`: chat and settings interfaces.
- `src/.wasm/`: parser runtime assets.
- `media/`: extension icons and fonts.

This source distribution excludes benchmark projects, experiment results, test fixtures and test source, model weights, caches, dependencies, and generated extension bundles.

## Tool feedback and iterative repair

The selected loop remains the generation target. VscOMP captures the complete
active file and other unsaved files in its workspace, replaces only the selected
range in a temporary project copy, and validates that program. Changes to other
loops are not generated automatically. Original workspace files are not edited.

Each round runs an edit-scope check, a GCC build, functional checks, and the
configured race detector before sending the evidence to the semantic reviewer.
The generator receives both tool diagnostics and repair suggestions on subsequent
rounds. There is no score or 90-point threshold. CoT-style structured diagnosis
and reviewer examples have independent switches:
`VscOMP.Reviewer.useStructuredAnalysis` and `VscOMP.Reviewer.useExamples`.

Results distinguish `validated`, `unverified`, `failed`, and `cancelled`.
`validated` means that all four configured checks completed successfully and
semantic review, if enabled, left no unresolved correctness issue. It is not a
proof for every input and thread schedule. Missing tests, unavailable tools, an
unconfirmed detector startup, or malformed review output never count as a pass.
Unaccepted candidates are shown separately and the original code is retained.
Passing an unchanged/serial candidate does not count as successful parallelization.

### Minimal GCC and functional-test configuration

Open a small C/C++ project in a trusted VS Code workspace. The extension host
must have access to GCC/G++ and the runtime libraries (use a Linux/WSL extension
host for the LLVM race-detector configuration below). This feature does not
translate Windows paths into WSL paths or execute commands on a remote server.

For a program that prints the sum of integers from 0 through 9999, select its `for` loop and
configure workspace settings as follows. This configuration intentionally remains
**unverified** until a race-detector backend is also configured:

```json
{
  "VscOMP.Validation": {
    "enabled": true,
    "compiler": "gcc",
    "threadCounts": [1, 2, 4],
    "timeoutMs": 30000,
    "tests": [
      { "name": "sum", "expectedStdout": "49995000\n" }
    ]
  }
}
```

C++ defaults to `g++` when `compiler` is omitted. The default build arguments are
`-O3 -g -fopenmp -Wall -Wextra {source} -o {binary}`. Multi-file projects can
provide an explicit build command, for example:

```json
{
  "build": {
    "command": "gcc",
    "args": ["-O3", "-g", "-fopenmp", "{source}", "{workspace}/helpers.c", "-o", "{binary}"]
  }
}
```

`command` is an executable and `args` is an argument array; shell syntax such as
`&&`, pipes and redirects is not evaluated. `{workspace}`, `{source}`, and
`{binary}` refer to the corresponding temporary reference/candidate copy and its
output artifact. Build commands must produce `{binary}`. Avoid absolute paths to
original source/build directories. Temporary copies protect source files from
replacement, but are not an operating-system sandbox for user-supplied commands.

Tests support `name`, `args`, `stdin`, `expectedExitCode` (default 0), and an
optional `expectedStdout`. If expected output and a checker are both omitted, the
program is compared with the unchanged reference build for the same input and
thread count. Empty reference output is insufficient: use an explicit expected
result or a checker. Outputs containing timing/random values need a meaningful
checker rather than whole-stdout comparison. `absoluteTolerance` and
`relativeTolerance` permit explicitly chosen numeric tolerances; other text must
match, apart from CRLF/LF normalization. Tolerances default to zero.

For benchmark verification, a test can supply a `verify` command that returns
zero only for correct results. It receives `{stdoutFile}`, `{stderrFile}`, and
`{exitCode}` placeholders in addition to the build placeholders. A nonzero
checker exit is a functional failure; inability to launch it is a tool error.
Keep final evaluation inputs separate from the inputs exposed during repair.

### Race-detector backend

GCC remains the primary build for functional checks and later performance
experiments. For supplementary OpenMP race checks, install a compatible
Clang/LLVM OpenMP runtime with Archer and configure a separate build. This is
a second executable of the **same candidate source**, not detection of the GCC
binary. Add this `race` object to `VscOMP.Validation`:

```json
{
  "race": {
    "build": {
      "command": "clang",
      "args": ["-O2", "-g", "-fopenmp", "-fsanitize=thread", "{source}", "-o", "{binary}"]
    },
    "activationPattern": "Archer detected OpenMP application with TSan, supplying OpenMP synchronization semantics",
    "env": { "ARCHER_OPTIONS": "verbose=1" }
  }
}
```

Use `clang++` for C++. Verify the actual detector startup message for the
installed runtime and make `activationPattern` specific to it. The expression
must match startup output from every tested execution; a zero exit code or an
empty report alone is insufficient. Race checks run all configured test inputs
with each configured thread count greater than one. TSan race/concurrency reports
are failures; missing activation, detector build failures and fatal runtime errors
are incomplete checks. A GCC+TSan backend can be configured with its own build
and activation mechanism, but is not assumed equivalent to Archer.

Both compilation and execution have a per-process timeout and bounded output.
Cancelling or timing out terminates the process tree. The runner records errors
instead of treating truncated output as successful validation. Project snapshots
omit `.git`, `node_modules`, `.vscode`, `.codex`, `.agents`, `.workbuddy`, and
`.vscomp-validation`, reject symbolic links, and default to 128 MiB / 10,000 files
per copy. `excludeDirectories` accepts additional basenames. Dirty workspace files
are overlaid on the snapshot. Build/runtime dependencies must be available through
the configured toolchain or included files.

After a run, temporary source copies and executables are removed. Per-round
candidate code, check coverage, diagnostics, review and timings remain in the
displayed temporary report directory as `iteration-N.json`. Reports contain source
and tool output; API authorization headers are not recorded. Tool feedback sent to
the models is bounded; the full captured evidence remains in the reports.
