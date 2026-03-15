import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		deps: {
			optimizer: {
				ssr: {
					include: ['just-bash', 'turndown'],
				},
			},
		},
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
