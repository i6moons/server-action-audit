# Contributing

Thanks for helping! Issues and pull requests are welcome, in English or French.

```sh
git clone https://github.com/i6moons/server-action-audit.git
cd server-action-audit
npm install
npm test
```

Before opening a pull request, `npm run typecheck`, `npm test` and `npm run build` should pass.

## Adding an auth library

1. Add the call to `NAMES` or `SUFFIXES` in [`src/options.ts`](src/options.ts), with a comment naming the library.
2. Add a case to the "recognizes %s" table in [`test/analyze.test.ts`](test/analyze.test.ts).
3. Link the library's docs in the pull request.

## Reporting a false positive or a false negative

Open an issue with the smallest snippet that reproduces it: the action, and the helper it calls if any. A false negative (an unprotected action reported as protected) is the most serious kind of bug here, so please report those first.
