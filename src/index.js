#! /usr/bin/env node
const fs = require('fs');
const sizeof = require('object-sizeof');
const JSONStream = require('JSONStream');
const { Command } = require('commander');
const { CallTree, buildAppmap } = require('@appland/models');

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

function codeObjectName(obj) {
  let classScope = [];
  let { parent } = obj;

  while (parent && parent.name) {
    classScope.push(parent.name);
    parent = parent.parent;
  }

  return `${classScope.reverse().join('.')}${obj.static ? '#' : '.'}${obj.name}`;
}

function eventName(classMap, e) {
  const callEvent = e.event === 'call' ? e : e.eventCall;
  const obj = classMap.get(callEvent);
  if (obj) {
    return codeObjectName(obj);
  }

  return `${callEvent.defined_class}${callEvent.static ? '#' : '.'}${callEvent.method_id}`;
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

program
  .command('prune <file>')
  .option('-s, --size <bytes>')
  .description('parse an appmap file from url')
  .action(async (file, cmd) => {
    let classMap;
    let pruneRatio = 1.0;
    let eventId = 10000;

    const appmap = buildAppmap()
      .source(await fromFile(file))
      .on('preprocess', (d) => {
        classMap = new ClassMap(d.data.classMap);
        pruneRatio = Math.min(cmd.size / d.size, 1);

        console.log(`Pruning chunks by ${((1.0 - pruneRatio) * 100).toFixed(2)}%`);
      })
      .event(event => {
        event.id = ++eventId;
        if (event.eventReturn) {
          event.eventReturn.parent_id = event.id;
        }
        return event;
      })
      .stack(events => events)
      .chunk((stacks) => {
        if (cmd.size === false) {
          return stacks;
        }

        // Begin pruning
        // We're storing size/count state in the global class map. This isn't
        // great but it works for now. Reset the counts for each chunk.
        classMap.forEach((obj) => {
          obj.size = 0;
          obj.count = 0;
        });

        stacks.flat(2).forEach((e) => {
          if (e.event !== 'call' || e.sql_query || e.http_server_request) {
            return;
          }

          const obj = classMap.get(e);
          if (obj) {
            const objSize = sizeof(e);
            obj.size = obj.size + objSize || objSize;
            obj.count = obj.count + 1 || 1;
          }
        });

        // Build an array of code objects sorted by size. The largest object
        // will always be index 0.
        let totalBytes = 0;
        const eventAggregates = Object
          .values(classMap.locationMap)
          .filter(obj => obj.size)
          .sort((a, b) => b.size - a.size)
          .map((obj) => ({
            name: codeObjectName(obj),
            count: obj.count,
            size: obj.size,
            totalBytes: totalBytes += obj.size
          }))
          .reverse();

        const exclusions = new Set();
        for(let i = 0; i < eventAggregates.length; ++i) {
          const eventInfo = eventAggregates[i];
          if (eventInfo.totalBytes <= totalBytes * pruneRatio) {
            break;
          }
          exclusions.add(eventInfo.name);
        }

        // Calculate totals for pruning.
        return stacks.map(events =>
          events.filter((e) => {
            const eventCall = e.event === 'call' ? e : e.eventCall;
            if (eventCall.http_server_request || eventCall.sql_query) {
              return true;
            }

            const name = eventName(classMap, e);
            console.log(name, exclusions.has(name));
            return !exclusions.has(name)
          }));
      })
      .build();

      // HACK
      // Break the parent -> child / child -> parent cycle in the class map
      // before serializing. Otherwise it will fail.
      traverse({children: appmap.classMap}, (obj) => delete obj.parent);

      fs.writeFileSync('data/out.json', appmap.toJson());
  });

program.parse(process.argv);
