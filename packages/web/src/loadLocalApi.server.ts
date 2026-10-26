/**
 * What the server build gets in place of `loadLocalApi.ts` — see there, and the
 * alias in vite.config.ts. Every call sits behind `if (staticBuild)`, so this
 * never runs; it throws rather than pretending, in case one ever slips out.
 */
import type * as Real from './loadLocalApi.js';

export const loadLocalApi: typeof Real.loadLocalApi = () => {
  throw new Error('The browser-side API is only in the static build.');
};
