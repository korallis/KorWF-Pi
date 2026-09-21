# Third-party notices

KorWF-Pi is MIT-licensed (see `LICENSE`, © 2026 Lee Barry). Some files under `src/`
may copy or adapt code from the example extensions shipped with **Pi**
(`@earendil-works/pi-coding-agent`, author Mario Zechner / earendil-works,
<https://github.com/earendil-works/pi>), under the reuse decisions recorded in
[docs/adr/0001-reuse-of-pi-examples.md](docs/adr/0001-reuse-of-pi-examples.md).

Pi's install tree ships no `LICENSE` file; its licence is declared as MIT in the
package's `package.json` (`"license": "MIT"`, `"author": "Mario Zechner"`) and README.
The notice below is reproduced verbatim from the upstream repository's `LICENSE` file
(`https://github.com/earendil-works/pi/blob/main/LICENSE`).

## Attribution rule

Every file in this repository whose content derives from a Pi example must begin with
the header comment defined in ADR 0001:

```
Adapted from pi <version> examples/extensions/<path> — MIT, © Mario Zechner / earendil-works
```

and must appear in the **Adapted files** table below. `test/notices/third-party-notices.test.ts`
(run by `npm test`) fails if a file carries such a header but is not listed here, or
if a listed file no longer carries the header.

## Adapted files

<!-- notices:adapted-files:start -->
| File in this repository | Source (`<pi-install>/examples/extensions/…`) | Pi version | ADR 0001 row |
|---|---|---|---|
| _none yet_ | — | — | — |
<!-- notices:adapted-files:end -->

As of the PR that created this file (#113), no file in `src/` has yet been copied or
adapted from a Pi example: the copy manifest in ADR 0001 names the planned targets
(`git/status.ts`, `workflow/approvals/dirty-tree.ts`, `extension/ui/questionnaire.ts`,
`workers/contracts/report-tool.ts`, `workers/roles.ts`, `workers/spawn.ts`,
`security/bash-classifier.ts`), but those modules are still placeholders. ADR 0001 was
written against Pi **0.86.0**; the version currently installed for development is
**0.86.1**. Each row added to the table must cite the exact version the code was read
from, which may differ per file.

## Pi (`@earendil-works/pi-coding-agent`) — MIT

<!-- notices:pi-license:start -->
```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
<!-- notices:pi-license:end -->

