# Installation
Pre-built binaries are available [here](https://github.com/applandinc/appmap-cli/releases).

or run via `npx`
```sh
$ npx @appland/appmap-cli
```

# Usage
```sh
$ appmap
Usage: appmap [options] [command]

Options:
  -V, --version           output the version number
  -h, --help              display help for command

Commands:
  prune [options] <file>  parse an appmap file from url
  help [command]          display help for command
```

## Pruning
`prune` will remove large event types to meet a maximum size requirement.
```sh
Usage: appmap prune [options] <input> <size>

prune an appmap file down to the given size (if applicable)

Options:
  -o, --output-dir <dir>  specify the output directory (default: ".")
  -h, --help              display help for command
```

Example:
```sh
$ appmap prune appland.results.json 2MB
```
