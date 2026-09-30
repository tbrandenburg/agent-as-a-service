const { readdir } = require("node:fs/promises");

module.exports = (RED) => {
  function CwdList(config) {
    RED.nodes.createNode(this, config);
    this.on("input", async (msg, send, done) => {
      try {
        msg.cwdListing = { directory: process.cwd(), files: await readdir(process.cwd()) };
        send(msg);
        done();
      } catch (error) {
        done(error);
      }
    });
  }
  RED.nodes.registerType("cwd-list-example", CwdList);
};
