# grhyph

Greek and Greeklish syllabification and hyphenation, with Go and JavaScript implementations.
The JavaScript port provides plain hyphenation and quick synizesis; the Go library also
includes regular-expression exception rules.

The UI uses the JavaScript implementation directly from this repository.

```sh
npm --prefix js test
go test ./...
go run ./grhyph_cli --quick-synizesis 'ποιότητα'
```

See [JavaScript usage](js/README.md). Licensed under **AGPL-3.0-or-later**;
see [LICENSE](LICENSE) and the preserved original copyright notice in [NOTICE](NOTICE).
