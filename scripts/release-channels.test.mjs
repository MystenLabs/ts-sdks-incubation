import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	dependencyWouldUseVersion,
	getNextBetaVersion,
	getPublishArguments,
	getReleaseChannel,
	replaceDependencyVersion,
	validateVersionForChannel,
} from './release-channels.mjs';

describe('release channels', () => {
	it('defaults packages to latest and recognizes beta packages', () => {
		assert.equal(getReleaseChannel({ name: 'stable' }), 'latest');
		assert.equal(getReleaseChannel({ name: 'beta', publishConfig: { tag: 'beta' } }), 'beta');
		assert.throws(
			() => getReleaseChannel({ name: 'next', publishConfig: { tag: 'next' } }),
			/unsupported publishConfig\.tag/,
		);
	});

	it('starts a beta sequence at zero', () => {
		assert.equal(
			getNextBetaVersion({
				targetVersion: '0.1.0',
				currentVersion: '0.0.0',
				publishedVersions: ['0.0.0'],
			}),
			'0.1.0-beta.0',
		);
	});

	it('increments independently from the highest local or published beta', () => {
		assert.equal(
			getNextBetaVersion({
				targetVersion: '0.1.0',
				currentVersion: '0.1.0-beta.1',
				publishedVersions: ['0.1.0-beta.0', '0.1.0-beta.2', '0.2.0-beta.8'],
			}),
			'0.1.0-beta.3',
		);
	});

	it('resets the counter for a new target version', () => {
		assert.equal(
			getNextBetaVersion({
				targetVersion: '0.2.0',
				currentVersion: '0.1.0-beta.3',
				publishedVersions: ['0.1.0-beta.4'],
			}),
			'0.2.0-beta.0',
		);
	});

	it('requires versions to match their release channel', () => {
		assert.doesNotThrow(() => validateVersionForChannel('beta', '0.1.0-beta.3', 'beta'));
		assert.doesNotThrow(() => validateVersionForChannel('stable', '0.1.0', 'latest'));
		assert.throws(() => validateVersionForChannel('beta', '0.1.0', 'beta'), /without a beta/);
		assert.throws(
			() => validateVersionForChannel('stable', '0.1.0-beta.0', 'latest'),
			/prerelease on the latest channel/,
		);
	});

	it('builds package-specific publish arguments', () => {
		assert.deepEqual(getPublishArguments({ name: 'stable' }), [
			'publish',
			'--tag',
			'latest',
			'--access',
			'public',
			'--no-git-checks',
		]);
		assert.deepEqual(
			getPublishArguments({ name: 'beta', publishConfig: { access: 'restricted', tag: 'beta' } }),
			['publish', '--tag', 'beta', '--access', 'restricted', '--no-git-checks'],
		);
	});

	it('identifies and rewrites dependency ranges that resolve to the beta version', () => {
		assert.equal(dependencyWouldUseVersion('workspace:^', '0.1.0'), true);
		assert.equal(dependencyWouldUseVersion('^0.1.0', '0.1.0'), true);
		assert.equal(dependencyWouldUseVersion('^0.0.1', '0.1.0'), false);
		assert.equal(
			replaceDependencyVersion('workspace:^0.1.0', '0.1.0', '0.1.0-beta.3'),
			'workspace:^0.1.0-beta.3',
		);
	});
});
