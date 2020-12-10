#! /usr/bin/env node
const fs = require('fs');
const sizeof = require('object-sizeof');
const JSONStream = require('JSONStream');
const { Command } = require('commander');
const { CallTree, buildAppmap } = require('@appland/models');
const { type } = require('os');

const program = new Command();

program.version('0.0.1');

function getStackId(collection) {
  return Object.keys(collection.activeStacks).length
    + collection.finalizedStacks.length;
}

class EventStack {
  constructor(id) {
    this.depth = 0;
    this.events = [];
    this.id = id;
  }

  add(event) {
    this.depth += (event.event === 'call' ? 1 : -1);
    this.events.push(event);
  }

  unwound() {
    return this.events.length !== 0 && this.depth === 0;
  }
}

function traverse(obj, fn, parent = null) {
  fn(obj, parent);

  if (obj.children) {
    obj.children.forEach(c => traverse(c, fn, obj))
  }
}


function compareClassMapObjects(a, b) {
  return a && b 
    && a.type === b.type
    && a.name === b.name
    && a.static === b.static
    && a.location === b.location;
}

function merge(a, b) {
  if (!compareClassMapObjects(a, b)) {
    return false;
  }

  b.children.forEach(bChild => {
    const match = a.children.find(aChild => compareClassMapObjects(aChild, bChild));
    if (!match) {
      a.children.push(bChild);
    } else {
      merge(match, bChild);
    }
  });
}

class ClassMap {
  constructor(data = []) {
    this.data = {children: [...data]};
    this.locationMap = {};

    traverse(this.data, (obj, parent) => {
      obj.parent = parent;

      if (obj.location) {
        this.locationMap[obj.location] = obj;
      }
    });
  }

  clone(event) {
    const obj = this.get(event);
    if (!obj) {
      return null;
    }

    let node = {...obj};
    while (node.parent) {
      node.parent = {...node.parent};
      node = node.parent;
    }

    return node;
  }

  merge(obj) {
    merge(this.data, obj);
  }

  get(event) {
    if (!event) {
      return null;
    }

    return this.locationMap[`${event.path}:${event.lineno}`];
  }

  forEach(fn) {
    traverse(this.data, fn);
  }
}

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

program
  .command('prune <file>')
  .option('-s, --size <bytes>')
  .description('parse an appmap file from url')
  .action(async (file, cmd) => {
    const builder = buildAppmap()
    .source(await fromFile(file))
    .normalize();

    if (cmd.size) {
      const bytes = parseSize(cmd.size);
      Object.entries(binaryPrefixes)
        .forEach(([k, v]) => console.log(`${bytes / v}${k}`))
      builder.prune(bytes);
    }

    const appmap = builder.build();
    fs.writeFileSync('data/out.appmap.json',
      JSON.stringify(appmap.serialize()));
  });

program.parse(process.argv);
