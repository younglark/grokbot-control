import { EXIT, GbcError, mapExitCode } from "../errors.js";
/** Same object shape on TTY and pipes: full envelope, unless --plain. */
export function outputMode(globals, isTTY) {
    return {
        plain: globals.plain,
        compact: globals.json || !isTTY,
    };
}
export function writeOut(data, compact) {
    if (compact) {
        process.stdout.write(JSON.stringify(data) + "\n");
    }
    else if (typeof data === "string") {
        process.stdout.write(data + (data.endsWith("\n") ? "" : "\n"));
    }
    else {
        process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
}
export function writeErrJson(data) {
    process.stderr.write(JSON.stringify(data) + "\n");
}
export function emitResult(r, mode) {
    if (r.ok) {
        writeOut(mode.plain ? (r.data ?? r) : r, mode.compact);
        return EXIT.SUCCESS;
    }
    writeErrJson(r);
    return mapExitCode(r.code, r.outcome, r.retryable);
}
export function usageExit(message, hint) {
    writeErrJson({
        schema_version: "1.0.0",
        ok: false,
        outcome: "known_failure",
        code: "usage",
        retryable: false,
        request_id: crypto.randomUUID(),
        error: { message, hint },
    });
    process.exit(EXIT.USAGE);
}
export function catchToExit(e, _mode) {
    if (e instanceof GbcError) {
        const r = {
            schema_version: "1.0.0",
            ok: false,
            outcome: e.outcome,
            code: e.code,
            retryable: e.retryable,
            request_id: crypto.randomUUID(),
            error: { message: e.message, hint: e.hint, details: e.details },
        };
        writeErrJson(r);
        return e.exitCode;
    }
    writeErrJson({
        schema_version: "1.0.0",
        ok: false,
        outcome: "known_failure",
        code: "error",
        retryable: false,
        request_id: crypto.randomUUID(),
        error: { message: String(e) },
    });
    return EXIT.ERROR;
}
