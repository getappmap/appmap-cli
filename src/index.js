#! /usr/bin/env node
const fs = require('fs');
const prettyBytes = require('pretty-bytes');
const sizeof = require('object-sizeof');
const JSONStream = require('JSONStream');
const { Command } = require('commander');
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
  console.log(b);
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
  })
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

class EventStackCollection {
  constructor() {
    this.activeStacks = {};
    this.finalizedStacks = [];
  }

  add(event) {
    let stack = this.activeStacks[event.thread_id];
    if (!stack) {
      const id = getStackId(this);
      stack = new EventStack(id);
      this.activeStacks[event.thread_id] = stack;
    }

    stack.add(event);

    if (stack.unwound()) {
      this.finalizedStacks.splice(stack.id, 0, stack.events);
      delete this.activeStacks[event.thread_id];
    }
  }

  get size() {
    let size = sizeof(Object.values(this.activeStacks));
    size += sizeof(this.finalizedStacks);
    return size;
  }

  // Iterate through every event added to this collection. This is slow and
  // should be refactored if it needs to be called more than once.
  forEach(fn) {
    // Join active and finalized stacks. We want to make sure we iterate over
    // every event.
    const stacks = [...this.finalizedStacks];
    Object
      .values(this.activeStacks)
      .forEach(s => stacks.splice(s.id, 0, s.events));

    stacks.reduce((acc, events) => {
      // Sanity check - we should never have an empty list of events
      if (events.length === 0) {
        return acc;
      }

      // We're the first chunk in, meaning we don't need to worry about any
      // chunks behind us. Just push it.
      if (acc.length === 0) {
        acc.push(events);
        return acc;
      }

      // If the root event is an HTTP request, this a complete chunk. Push it.
      if (events[0].http_server_request) {
        acc.push(events);
        return acc;
      }

      // Check to see if the previous chunk began with an HTTP request. If it
      // does, push a new chunk. Otherwise, append to the last chunk.
      const prevChunk = acc[acc.length - 1];
      if (prevChunk[0].http_server_request) {
        acc.push(events);
      } else {
        // I'm opting not to use a spread operator here to avoid a stack
        // overflow when processing a large file.
        events.forEach(e => prevChunk.push(e));
      }

      return acc;
    }, []).forEach(fn);
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

function eventName(e) {
  return `${e.defined_class}${e.static ? '#' : '.'}${e.method_id}`;
}

program
  .command('prune <file>')
  .option('-s, --size <bytes>')
  .description('parse an appmap file from url')
  .action((file, cmd) => {
    let data = {};
    const chunks = new EventStackCollection();
    const jsonStream = JSONStream.parse('events.*')
      .on('header', obj => data = {...data, ...obj})
      .on('footer', obj => data = {...data, ...obj})
      .on('data', e => chunks.add(e))
      .on('close', () => {
        const classMap = new ClassMap(data.classMap);
        const pruneRatio = Math.min(cmd.size / chunks.size, 1);
        const prunedEvents = [];

        console.log(`Pruning chunks by ${((1.0 - pruneRatio) * 100).toFixed(2)}%`);

        chunks.forEach((events) => {
          // Sanity check. This should never occur.
          if (events.length === 0) {
            return;
          }

          // We're storing size/count state in the global class map. This isn't
          // great but it works for now. Reset the counts for each chunk.
          classMap.forEach((obj) => {
            obj.size = 0;
            obj.count = 0;
          });

          // Calculate totals for pruning.
          events.forEach((e) => {
            if (e.event !== 'call' || e.sql_query || e.http_server_request) {
              return;
            }
  
            const obj = classMap.get(e);
            if (obj) {
              const size = sizeof(e);
              obj.size = obj.size + size || size;
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

          // Perform pruning
          if (cmd.size) {
            const exclusions = new Set();
            for(let i = 0; i < eventAggregates.length; ++i) {
              const eventInfo = eventAggregates[i];
              if (eventInfo.totalBytes <= totalBytes * pruneRatio) {
                break;
              }
              exclusions.add(eventInfo.name);
            }
            
            events
              .filter(e => !exclusions.has(eventName(e)))
              .forEach(e => prunedEvents.push(e));
          }
        });

        // HACK
        // Break the parent -> child / child -> parent cycle in the class map
        // before serializing. Otherwise it will fail.
        traverse({children: data.classMap}, (obj) => delete obj.parent);

        fs.writeFileSync('data/out.json', JSON.stringify({...data, events: prunedEvents}));
      });

    fs.createReadStream(file).pipe(jsonStream);
  });

program.parse(process.argv);
