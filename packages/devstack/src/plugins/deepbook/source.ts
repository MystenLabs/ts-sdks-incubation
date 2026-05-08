// `deepbook.source` — fetches + builds the upstream DeepBook source as a
// content-addressed `mysten-devstack/upstream-source:deepbookv3-<version>`
// image via BuildKit's git context. The publish action below extracts
// /src from this image into the sui localnet container and runs
// `sui client test-publish --with-unpublished-dependencies`.

import { buildImage } from '../../actions/build.js';
import {
	ensureUpstreamSourceImage,
	upstreamSourceImageTag,
} from '../../helpers/upstream-source.js';
import { imageExists } from '../../runtime/docker/index.js';

export const DEEPBOOK_REPO = 'MystenLabs/deepbookv3';
export const DEEPBOOK_SUBDIR = 'packages/deepbook';

export function deepbookSourceAction(version: string) {
	const imageTag = upstreamSourceImageTag(DEEPBOOK_REPO, version);
	return buildImage({
		name: 'source',
		inputs: { image: imageTag, repo: DEEPBOOK_REPO, version },
		getStatus: async () =>
			(await imageExists(imageTag))
				? { ok: true, detail: imageTag }
				: { ok: false, detail: `image ${imageTag} missing` },
		run: async (ctx) => {
			await ensureUpstreamSourceImage({
				repo: DEEPBOOK_REPO,
				rev: version,
				appendLog: ctx.appendLog,
			});
		},
	});
}
