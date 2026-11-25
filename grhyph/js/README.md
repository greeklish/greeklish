# grhyph-js

JavaScript subproject for the partial rewrite of `grhyph`'s Go implementation.

This package currently ports the plain hyphenation path plus the `QuickSynizesis`
option. It does not port the full `UseGrhyphRules` regular-expression exception
system from the Go package.

## Files

- `quickSynizesis.js` exports `hyphenate()`.
- `index.js` provides a small CLI wrapper.
- `quickSynizesis.test.js` contains focused quick-synizesis tests.

## Usage

```js
import { hyphenate } from './quickSynizesis.js';

const result = hyphenate('ποιότητα', {
  quickSynizesis: true,
  separator: '-',
});
```

```sh
node index.js --separator - "ποιότητα"
```

## Test

```sh
npm test
```

## License

AGPL-3.0-or-later; see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
