# zerithdb-sync

## [0.1.0](https://github.com/anish27863/ZerithDB/compare/zerithdb-sync-v0.0.1...zerithdb-sync-v0.1.0) (2026-05-17)


### Features

* add P2P video conferencing orchestration ([#527](https://github.com/anish27863/ZerithDB/issues/527)) ([0f839eb](https://github.com/anish27863/ZerithDB/commit/0f839eba43629c5fcfdfcd5560e1b771dc045f3a))
* **cli:** add global experimental flag for beta features ([#625](https://github.com/anish27863/ZerithDB/issues/625)) ([c219504](https://github.com/anish27863/ZerithDB/commit/c219504b9796cecfb0febaa88add5f0a6c60aefe))
* improve framework icon styles and add floating animations ([#562](https://github.com/anish27863/ZerithDB/issues/562)) ([97fc289](https://github.com/anish27863/ZerithDB/commit/97fc289c6ecb2cd9d6e928dd00954638fc74685c))
* **playground:** improve onboarding with quick-start guide and interactive empty states ([#691](https://github.com/anish27863/ZerithDB/issues/691)) ([d0f77c1](https://github.com/anish27863/ZerithDB/commit/d0f77c15ba6ae09c17deab2b5060f5cfef302f53))
* production launch — web app, HF signaling, Python SDK, CLI ([7c655a1](https://github.com/anish27863/ZerithDB/commit/7c655a140c2ed34cefbcf50486e9418db2bc21f0))


### Bug Fixes

* navbar hover text color visibility in dark mode ([#672](https://github.com/anish27863/ZerithDB/issues/672)) ([fc0b3f5](https://github.com/anish27863/ZerithDB/commit/fc0b3f54708a50f9deba73a852da0e8bac607f01))
* remove lint and test scripts from stub packages ([37bece9](https://github.com/anish27863/ZerithDB/commit/37bece9af8e97798541f74393a946e803e9e5178))
* reset React state on Clear DB button click ([#512](https://github.com/anish27863/ZerithDB/issues/512)) ([05e138e](https://github.com/anish27863/ZerithDB/commit/05e138eeca4d5fba5b899d39e677ecaf4862eaaa))
* resolve 10 bugs across sync, network, db, react, sdk, and cli packages ([#469](https://github.com/anish27863/ZerithDB/issues/469)) ([e357900](https://github.com/anish27863/ZerithDB/commit/e357900cbab5b38879c0c3b36123e3d2dc2ea8b6))
* resolve all merge conflicts with upstream/main ([313ab38](https://github.com/anish27863/ZerithDB/commit/313ab38e0510c41117b01dcb87abc1aef06ec3e8))
* resolve merge conflicts with upstream/main ([f449ebd](https://github.com/anish27863/ZerithDB/commit/f449ebd68f3f7caacaa04021d10eea4930050230))
* **sdk:** resolve conflicts and improve indexeddb check ([de3df7f](https://github.com/anish27863/ZerithDB/commit/de3df7fda130d34ac5bc6c68edabea596c9ce74a))
* stabilize monorepo build, fix types and missing layouts ([43bbc78](https://github.com/anish27863/ZerithDB/commit/43bbc78dfe4ec204fdc1afba29bdfaf9ee93174b))
* **sync:** pause sync loop on tab hide to reduce mobile battery drain ([#305](https://github.com/anish27863/ZerithDB/issues/305)) ([fdcf901](https://github.com/anish27863/ZerithDB/commit/fdcf9018fe6d27bb21c9036c6a35b6be5611cdc4))
* **sync:** re-add zerithdb-utils import after merge ([be50011](https://github.com/anish27863/ZerithDB/commit/be50011bde21b84c5c8321e7efb6fc67b8b7f8e3))
* **sync:** remove duplicate base64 utilities and import from utils ([89ea2c7](https://github.com/anish27863/ZerithDB/commit/89ea2c71a0636baab14c0ee55661fe3f02cbc32a))
* **sync:** replace spread-based bytesToBase64 with loop to prevent RangeError on large arrays ([fc49b02](https://github.com/anish27863/ZerithDB/commit/fc49b02e7e6525cac0acfe0713b5dec9b1fdf75e))
* **web:** repair landing page footer links ([#564](https://github.com/anish27863/ZerithDB/issues/564)) ([c00b696](https://github.com/anish27863/ZerithDB/commit/c00b6969f5735b2286fb673c6fdcd7229fdda213))

## 0.2.0

### Minor Changes

- 4f1cee0: Initial Beta Release of ZerithDB ecosystem! Features include CRDT sync, local-first
  WebRTC networking, React hooks, CLI, and more.

### Patch Changes

- Updated dependencies [4f1cee0]
  - zerithdb-core@0.2.0
  - zerithdb-db@0.2.0
  - zerithdb-network@0.2.0
