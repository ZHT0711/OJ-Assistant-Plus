import { FJUTACMOJ } from './fjutacm/FJUTACMOJ';
import { CodeforcesOJ } from './codeforces/CodeforcesOJ';
import { NEUOJ } from './neuoj/NEUOJ';
import { CSECG } from './csecg/CSECG';
import { LuoguOJ } from './luogu/LuoguOJ';
import { LeetCodeOJ } from './leetcode/LeetCodeOJ';
import { HNUACMOJ } from './hnuacm/HNUACMOJ';
import { HDOJ } from './hdoj/HDOJ';
import { HNUCG } from './hnucg/HNUCG';
import { platformAdapters } from './platforms';

/** Canonical id -> implementation. Aliases are registered below. */
const implementations: { [key: string]: any } = {
	'fjutacm': FJUTACMOJ,
	'codeforces': CodeforcesOJ,
	'neuoj': NEUOJ,
	'csecg': CSECG,
	'luogu': LuoguOJ,
	'leetcode': LeetCodeOJ,
	'hnuacm': HNUACMOJ,
	'hnucg': HNUCG,
	'hdoj': HDOJ,
};

/**
 * Platform registry used by the config loader and the problem tree.
 * Tests may register extra implementations (e.g. a fixture backend).
 */
export const backends: { [key: string]: any } = {};
for (const adapter of platformAdapters) {
	const implementation = implementations[adapter.id];
	if (!implementation) { continue; }
	backends[adapter.id] = implementation;
	for (const alias of adapter.aliases) { backends[alias] = implementation; }
}

export { adapterFor, platformAdapters } from './platforms';
export type { LoginSpec, PlatformAdapter } from './platforms';
