/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as appearance from "../appearance.js";
import type * as lib_appearance from "../lib/appearance.js";
import type * as lib_arrangementPrompt from "../lib/arrangementPrompt.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_melodyPrompt from "../lib/melodyPrompt.js";
import type * as lib_openrouter from "../lib/openrouter.js";
import type * as lib_songOptions from "../lib/songOptions.js";
import type * as lib_songPrompt from "../lib/songPrompt.js";
import type * as lib_songValidators from "../lib/songValidators.js";
import type * as lib_syllables from "../lib/syllables.js";
import type * as songs from "../songs.js";
import type * as user from "../user.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  appearance: typeof appearance;
  "lib/appearance": typeof lib_appearance;
  "lib/arrangementPrompt": typeof lib_arrangementPrompt;
  "lib/auth": typeof lib_auth;
  "lib/melodyPrompt": typeof lib_melodyPrompt;
  "lib/openrouter": typeof lib_openrouter;
  "lib/songOptions": typeof lib_songOptions;
  "lib/songPrompt": typeof lib_songPrompt;
  "lib/songValidators": typeof lib_songValidators;
  "lib/syllables": typeof lib_syllables;
  songs: typeof songs;
  user: typeof user;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
