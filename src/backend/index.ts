import { FJUTACMOJ } from './fjutacm/FJUTACMOJ';
import { CodeforcesOJ } from './codeforces/CodeforcesOJ';
import { NEUOJ } from './neuoj/NEUOJ';
import { CSECG } from './csecg/CSECG';
import { LuoguOJ } from './luogu/LuoguOJ';
import { LeetCodeOJ } from './leetcode/LeetCodeOJ';

export const backends: { [key: string]: any } = {
	'fjutacm': FJUTACMOJ,
	'codeforces': CodeforcesOJ,
	'neuoj': NEUOJ,
	'csecg': CSECG,
	'luogu': LuoguOJ,
	'leetcode': LeetCodeOJ,
};
