const fs = require('fs/promises');
class JsonFile {
  constructor(path) {
    this.path = path;

    fs.open(path, 'r')
      .then(fd => this.fd = fd);
  }
}
