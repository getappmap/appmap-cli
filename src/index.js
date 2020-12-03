#! /usr/bin/env node
const JSONStream = require('JSONStream');
const request = require('request');
const fs = require('fs/promises');
const { Command } = require('commander');
const program = new Command();

program.version('0.0.1');

program
  .command('upload <file>')
  .description('upload an appmap file')
  .action((file) => {
    console.log(`uploading ${file}`);
  });

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
  fn(obj);

  if (parent) {
    obj.parent = parent;
  }

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

    traverse(this.data, (obj) => {
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

  toArray() {
    const stacks = [...this.finalizedStacks];
    Object
      .values(this.activeStacks)
      .forEach(s => stacks.splice(s.id, 0, s.events));
    return stacks;
  }

  forEach(fn) {
    const stacks = [...this.finalizedStacks];
    Object
      .values(this.activeStacks)
      .forEach(s => stacks.splice(s.id, 0, s.events));

    // TODO: clean me up
    let lastRootEvent = null;
    stacks.reduce((acc, events) => {
      const firstEvent = events[0];
      if (!firstEvent) {
        return acc;
      }

      if (firstEvent.http_server_request) {
        acc.push(events);
      } else {
        let currentStack = null;
        if (!lastRootEvent || lastRootEvent.http_server_request) {
          currentStack = [];
          acc.push(currentStack);
        } else {
          currentStack = acc[acc.length - 1];
        }

        currentStack.splice(currentStack.length - 1, 0, events);
      }

      lastRootEvent = firstEvent;
      return acc;
    }, []).forEach(fn);
  }
}

program
  .command('parse <url>')
  .description('parse an appmap file from url')
  .action((url) => {
    const stream = JSONStream.parse('events.*');
    request(url).pipe(stream);

    const stackCollection = new EventStackCollection();
    let classMap = null;
    let header = {};
    stream
      .on('header', d => header = d)
      .on('data', d => stackCollection.add(d))
      .on('close', () => {
        const mainClassMap = new ClassMap(header.classMap);
        stackCollection.forEach((s) => {
          s.forEach((e) => {
            const obj = mainClassMap.get(e);
            if (obj) {
              obj.count = obj.count + 1 || 1;
            }
          });
        })

        Object
        .values(mainClassMap.locationMap)
        .filter(obj => obj.count)
        .sort((a, b) => a.count - b.count)
        .forEach((obj) => {
          console.log(`${obj.parent.name}${obj.static ? '#' : '.'}${obj.name} -> ${obj.count}`);
        });
        // console.log(mainClassMap);
        // stackCollection.forEach((s, i) => {
          // const classMap = new ClassMap();
          // s.forEach((e) => {
          //   const obj = mainClassMap.clone(e);
          //   classMap.merge(obj);
          // });
          // console.log(classMap);
          // fs.writeFile(`data/${i}.appmap.json`, JSON.stringify({...header, events: s}))
        // })
      });

    // stream.on('header', (d) => {
    //   console.error(d);
    // });
      // .pipe(es.mapSync((data) => {
      //   console.error(data)
      //   return data
      // }))
      // .pipe(process.stdout);
  });

program.parse(process.argv);
