'use strict';

// Static preload keeps filesystem paths out of generated JavaScript source.
global.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => require('../../.github/scripts/__tests__/fixtures/patch-metadata/morphe-2.1.0-excerpt.json'),
});
