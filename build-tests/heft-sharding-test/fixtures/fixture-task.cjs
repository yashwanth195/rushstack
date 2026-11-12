// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

const fs = require('node:fs');
const path = require('node:path');

module.exports = class FixtureTask {
  apply(session, configuration, options) {
    session.hooks.run.tapPromise('fixture-observer', async () => {
      const root = configuration.buildFolderPath;
      const telemetry = path.join(root, 'temp', 'instrumentation');
      fs.mkdirSync(telemetry, { recursive: true });
      fs.appendFileSync(
        path.join(telemetry, `${options.action}.jsonl`),
        `${JSON.stringify({ generation: process.env.RUSH_SHARD_GENERATION ?? null })}\n`
      );
      if (options.action !== 'before-collate') return;

      // Fault injection is exclusively a fixture task, ordered after real Rush shard execution/cache
      // restoration and before the shipped collator. It never supplies results or overrides verdicts.
      const faultPath = path.join(root, 'temp', 'fault.json');
      if (!fs.existsSync(faultPath)) return;
      const { fault } = JSON.parse(fs.readFileSync(faultPath, 'utf8'));
      const parent = path.join(root, 'temp', 'shards');
      const first = path.join(parent, '1', 'shard-manifest.json');
      const second = path.join(parent, '2', 'shard-manifest.json');
      if (fault === 'missing') fs.unlinkSync(first);
      else if (fault === 'corrupt') fs.writeFileSync(first, '{broken');
      else if (fault === 'duplicate-file') {
        const a = JSON.parse(fs.readFileSync(first, 'utf8'));
        const b = JSON.parse(fs.readFileSync(second, 'utf8'));
        b.payload.testFiles[0].path = a.payload.testFiles[0].path;
        fs.writeFileSync(second, JSON.stringify(b));
      } else if (fault === 'extra') {
        fs.mkdirSync(path.join(parent, '99'));
        fs.copyFileSync(first, path.join(parent, '99', 'shard-manifest.json'));
      } else if (fault === 'stale' || fault === 'mixed') {
        for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory() || (fault === 'mixed' && entry.name !== '1')) continue;
          const filename = path.join(parent, entry.name, 'shard-manifest.json');
          const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
          manifest.generation = 'uniformly-stale';
          fs.writeFileSync(filename, JSON.stringify(manifest));
        }
      } else throw new Error(`Unknown fixture fault: ${fault}`);
    });
  }
};
