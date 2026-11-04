#!/bin/sh
# Unit and e2e coverage of one app merged into coverage/merged. Run from the app dir (its `test:e2e:cov` script).
set -eu

rm -rf .vitest/blob
vitest run --coverage --reporter=default --reporter=blob --outputFile.blob=.vitest/blob/unit.json
vitest run --config ./test/vitest-e2e.config.mts --coverage --reporter=default --reporter=blob --outputFile.blob=.vitest/blob/e2e.json
vitest run --merge-reports=.vitest/blob --config ./test/vitest-coverage-merge.config.mts --coverage
