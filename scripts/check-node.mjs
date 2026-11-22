// Runs automatically before `npm install` / `npm ci`. Stops early on the wrong Node version.
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) {
  console.error(
    `\nThis project needs Node.js 24 LTS, but you are running ${process.version}.\n` +
      'Install Node.js 24 LTS from https://nodejs.org, reopen the terminal, and run npm install again.\n',
  );
  process.exit(1);
}
