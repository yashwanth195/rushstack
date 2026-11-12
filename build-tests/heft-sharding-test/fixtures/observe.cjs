// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

const fs = require('node:fs');
const path = require('node:path');
const folder = path.join(process.cwd(), 'temp', 'instrumentation');
fs.mkdirSync(folder, { recursive: true });
fs.appendFileSync(path.join(folder, 'suites.jsonl'), `${JSON.stringify(expect.getState().testPath)}\n`);
