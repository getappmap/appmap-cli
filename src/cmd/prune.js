#! /usr/bin/env node
const fs = require('fs');
const JSONStream = require('JSONStream');
const { basename } = require('path');
const { buildAppMap } = require('@appland/models');

async function fromFile(filePath) {
  let data = { events: [] };

  return new Promise((resolve, reject) => {
    const jsonStream = JSONStream.parse('events.*')
      .on('header', obj => data = {...data, ...obj})
      .on('footer', obj => data = {...data, ...obj})
      .on('data', e => data.events.push(e))
      .on('close', () => resolve(data));

    fs.createReadStream(filePath).pipe(jsonStream);
  });
}

const binaryPrefixes = {
  B: 1,
  KB: 1 << 10,
  MB: 1 << 20,
  GB: 1 << 30,
};

// This isn't very robust
function parseSize(size) {
  const [_, byteStr, unit] = /(\d+)[\s+]?(\w+)?/.exec(size);
  if (!unit) {
    return Number(byteStr);
  }

  const p = binaryPrefixes[unit.toUpperCase()];
  if (!p) {
    throw `unknown size ${size}`;
  }

  return Number(byteStr) * p;
}

module.exports = (program) => {
  program
    .command('prune <file> <size>')
    .option('-o, --output-dir <dir>', 'specify the output directory', '.')
    .description('prune an appmap file down to the given size (if applicable)')
    .action(async (file, size, cmd) => {
      const bytes = parseSize(size);
      const appmap = buildAppMap()
        .source(await fromFile(file))
        .prune(bytes)
        .normalize()
        .build();

      const outputPath = `${cmd.outputDir}/${basename(file)}`;
      fs.writeFileSync(outputPath, JSON.stringify(appmap));
    });
};
