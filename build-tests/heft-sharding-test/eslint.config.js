// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

const profile = require('local-node-rig/profiles/default/includes/eslint/flat/profile/node-trusted-tool');
const friendlyLocals = require('local-node-rig/profiles/default/includes/eslint/flat/mixins/friendly-locals');

module.exports = [
  ...profile,
  ...friendlyLocals,
  { files: ['**/*.ts'], languageOptions: { parserOptions: { tsconfigRootDir: __dirname } } }
];
