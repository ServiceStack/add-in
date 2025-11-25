const assert = require('assert');
const { parseGistLinks } = require('../lib/index.js');

// Test parseGistLinks
console.log('Testing parseGistLinks...');

const testMd = `
# Mix Registry

 - [init](https://gist.github.com/gistlyn/58030e271595520d87873c5df5e14f60) {} \`project,sharp,ss\` Empty .NET 6.0 ServiceStack App
 - [redis](https://gist.github.com/gistlyn/67d6c72fba8e07c4aeb82d3bb6bfef0f) {to:"$HOST"} \`db\` Use ServiceStack.Redis
 - [sqlite](https://gist.github.com/gistlyn/e9f70c3f68e6c7a1a80c25cdc7bc71e7) {to:"$HOST"} \`db,lite\` Use OrmLite with SQLite
 - [auth](https://gist.github.com/gistlyn/1ec54e10d44f87e0f20daaf7e2248fea) {to:"$HOST"} \`auth\` Configure ServiceStack Auth
`;

const links = parseGistLinks(testMd);

assert.strictEqual(links.length, 4, 'Should parse 4 links');

assert.strictEqual(links[0].name, 'init', 'First link name should be "init"');
assert.strictEqual(links[0].url, 'https://gist.github.com/gistlyn/58030e271595520d87873c5df5e14f60');
assert.deepStrictEqual(links[0].tags, ['project', 'sharp', 'ss']);
assert.strictEqual(links[0].to, null);

assert.strictEqual(links[1].name, 'redis', 'Second link name should be "redis"');
assert.strictEqual(links[1].to, '$HOST');
assert.deepStrictEqual(links[1].tags, ['db']);

assert.strictEqual(links[2].name, 'sqlite');
assert.strictEqual(links[2].to, '$HOST');
assert.deepStrictEqual(links[2].tags, ['db', 'lite']);

assert.strictEqual(links[3].name, 'auth');
assert.strictEqual(links[3].to, '$HOST');
assert.deepStrictEqual(links[3].tags, ['auth']);

console.log('✓ parseGistLinks tests passed');

// Test edge cases
console.log('Testing edge cases...');

// Empty markdown
const emptyLinks = parseGistLinks('');
assert.strictEqual(emptyLinks.length, 0, 'Empty markdown should return empty array');

// Markdown with no links
const noLinks = parseGistLinks('# Title\n\nSome text');
assert.strictEqual(noLinks.length, 0, 'No links should return empty array');

// Link with GitHub repo URL
const repoMd = ` - [blazor](https://github.com/user/repo) {} \`ui\` Blazor template`;
const repoLinks = parseGistLinks(repoMd);
assert.strictEqual(repoLinks.length, 1);
assert.strictEqual(repoLinks[0].name, 'blazor');
assert.strictEqual(repoLinks[0].user, 'user');
assert.strictEqual(repoLinks[0].repo, 'repo');

console.log('✓ Edge cases tests passed');

// Test user normalization
console.log('Testing user normalization...');

const mythzMd = ` - [test](https://gist.github.com/mythz/abc123) {} \`\` Description`;
const mythzLinks = parseGistLinks(mythzMd);
assert.strictEqual(mythzLinks[0].user, 'ServiceStack', 'mythz should be normalized to ServiceStack');

const gistlynMd = ` - [test](https://gist.github.com/gistlyn/abc123) {} \`\` Description`;
const gistlynLinks = parseGistLinks(gistlynMd);
assert.strictEqual(gistlynLinks[0].user, 'ServiceStack', 'gistlyn should be normalized to ServiceStack');

console.log('✓ User normalization tests passed');

console.log('✓ All tests passed!');

