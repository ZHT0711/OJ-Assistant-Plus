import { CSECG } from '../csecg/CSECG';

/** HNU's CourseGrading deployment uses the same JSP protocol as CSECG. */
export class HNUCG extends CSECG {
    constructor(config: any) {
        super(Object.assign({}, config, {
            baseUrl: (config?.baseUrl as string) ?? 'https://cg.hnu.edu.cn',
        }) as any);
    }
}
