#! /usr/bin/env node
const fs = require('fs');
const { join } = require('path');
const { Command } = require('commander');
const { version } = require('../package.json');

const program = new Command();

fs.readdirSync(join(__dirname, 'cmd'))
  .map(srcFile => join(__dirname, 'cmd', srcFile))
  .forEach(srcFile => require(srcFile)(program));

program
  .version(version)
  .parse(process.argv);
