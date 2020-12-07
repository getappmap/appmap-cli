# Installation
```
$ npm install
```

# Usage
```
$ node src/index.js
Usage: index [options] [command]

Options:
  -V, --version           output the version number
  -h, --help              display help for command

Commands:
  prune [options] <file>  parse an appmap file from url
  help [command]          display help for command
```

## Pruning
`prune` will remove large event types to meet a maximum size requirement.
```
Usage: index prune [options] <file>

parse an appmap file from url

Options:
  -s, --size <bytes>  
  -h, --help          display help for command
```

Example:
```
# provide the size in bytes
$ node src/index.js prune appland.results.json --size 150000000
```
