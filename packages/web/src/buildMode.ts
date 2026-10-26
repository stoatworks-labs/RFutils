/**
 * Which build this is. Kept in its own module with no imports so that
 * `staticBuild` is a bare compile-time constant: Vite substitutes the literal,
 * and the dead `if (staticBuild)` branches in api.ts and App.tsx are dropped
 * from the server build.
 *
 * Keeping pdfjs out of the server build does not rest on this: the module that
 * loads localApi is swapped out of it altogether (see loadLocalApi.ts).
 */
export const staticBuild = import.meta.env.VITE_RFUTILS_STATIC === '1';
