import { FJUTACMOJ } from './fjutacm/FJUTACMOJ';
import { CodeforcesOJ } from './codeforces/CodeforcesOJ';
import { NEUOJ } from './neuoj/NEUOJ';
import { CSECG } from './csecg/CSECG';
import { LuoguOJ } from './luogu/LuoguOJ';
import { LeetCodeOJ } from './leetcode/LeetCodeOJ';
import { HNUACMOJ } from './hnuacm/HNUACMOJ';
import { HNUCG } from './hnucg/HNUCG';

export const backends: { [key: string]: any } = {
	'fjutacm': FJUTACMOJ,
	'codeforces': CodeforcesOJ,
	'neuoj': NEUOJ,
	'csecg': CSECG,
	'luogu': LuoguOJ,
	'leetcode': LeetCodeOJ,
	'hnuacm': HNUACMOJ,
	'hnucg': HNUCG,
	// Accept readable aliases in hand-written configuration files.
	'hnu-acm': HNUACMOJ,
	'hnu-cg': HNUCG,
};
