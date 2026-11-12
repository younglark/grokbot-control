import { type CliGlobal } from "./config.js";
import type { ResultEnvelope } from "../dto/result.js";
/** Sync opts are deliberately strict; an unknown selector must not broaden a pull. */
export declare function syncCommand(globals: CliGlobal, rest: string[]): Promise<ResultEnvelope>;
