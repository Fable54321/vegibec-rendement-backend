const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require.resolve('../app/routes/USDA.ts'), 'utf8');
function load(responses) {
  const calls = [];
  const exports = {};
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;
  const mockFetch = async url => {
      calls.push(url);
      return {ok: true, headers: {get: () => 'application/json'}, text: async () => JSON.stringify(responses.shift() ?? {results: []})};
    };
  vm.runInNewContext(code, {
    exports, require: name => name === 'express' ? {Router: () => ({get() {}})} : name.includes('db') ? {pool: {}} : name === 'node-fetch' ? mockFetch : (() => { throw new Error('Unexpected import: ' + name); })(),
    process: {env: {}}, Buffer, AbortController, setTimeout, clearTimeout, console,

  });
  return { ...exports, calls };
}
test('normalizes ISO and USDA dates and rejects invalid dates', () => {
  const api = load([]);
  assert.equal(api.normalizeReportDate('2026-09-04'), '09/04/2026');
  assert.equal(api.normalizeReportDate('9/4/2026'), '09/04/2026');
  for (const value of ['2026-02-30', '2026-13-01', '', ['2026-09-04']]) assert.equal(api.normalizeReportDate(value), null);
});
test('empty first response does not hide a historical report', async () => {
  const api = load([{results: []}, {results: [{slug_id: 123, report_date: '09/04/2026'}]}]);
  const report = await api.fetchReport(123, '09/04/2026');
  assert.equal(report.results.length, 1);
  assert.equal(api.calls.length, 2);
  assert.ok(decodeURIComponent(api.calls[1]).includes('report_begin_date=09/04/2026'));
});
test('ignores latest-date rows when requesting a historical date', async () => {
  const api = load([{results: [{report_date: '09/08/2026'}]}, {results: [{report_date: '09/04/2026'}]}]);
  const report = await api.fetchReport(123, '09/04/2026');
  assert.equal(report.results[0].report_date, '09/04/2026');
  assert.equal(api.calls.length, 2);
});
test('empty results exhaust alternate queries and remain an empty report', async () => {
  const api = load([]);
  const report = await api.fetchReport(123, '09/04/2026');
  assert.equal(report.results.length, 0);
  assert.equal(api.calls.length, 8);
});
